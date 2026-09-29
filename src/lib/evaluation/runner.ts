// 1 回の評価実行の進め方。**2 段**で進む (docs/spec.md UC-07):
//   1. ケースごとに評価対象エージェントへ入力を投げ、応答を得る
//   2. 得た応答を judge にバッチで採点させる
//
// **どの段が失敗してもケース単位の除外に落として続行する** (受け入れ基準「評価失敗時の
// フォールバック」)。1 ケースの失敗で実行全体を捨てると、残りの採点まで失われる
import type { CaseVerdict } from '@/domain/evaluation/judge-output';
import type { JudgeCaseInput } from '@/domain/evaluation/prompt';
import { exclusionRate, summarize, type RunTotals } from '@/domain/evaluation/scores';
import { EvaluationExclusionReason, EvaluationRunStatus } from '@/domain/types';
import {
  EVALUATION_CONCURRENCY,
  EVALUATION_JUDGE_BATCH_SIZE,
  EVALUATION_MAX_EXCLUSION_RATE,
  EVALUATION_RESPONSE_MAX_CHARS,
  EVALUATION_TRUNCATION_MARK,
} from '@/lib/constants';
import { requestAgentResponse, type AgentTarget } from './agent-response';
import { scoreBatch, type JudgeIdentity } from './judge';

/** 採点する 1 ケース (評価セットから読んだ行) */
export interface EvaluationCaseInput {
  // ケース ID
  caseId: string;
  // エージェントへの入力
  input: string;
  // 期待する出力 (無ければ null)
  expected: string | null;
}

/** 1 回の実行の結果 (そのまま EvaluationRun / EvaluationResult に保存できる形) */
export interface EvaluationOutcome {
  // ケースごとの判定 (依頼した順)
  verdicts: CaseVerdict[];
  // 実行全体の集計
  totals: RunTotals;
  // 採点として使えるか
  status: EvaluationRunStatus;
}

/**
 * 並列度を絞って順に処理し、**入力と同じ順序**で結果を返す。
 * 1 実行で最大 EVALUATION_SET_MAX_CASES 回の往復が起きるので、逐次だと待ち時間が積み上がる。
 * 並列度が 1 未満なら**進まなくなる**ので設定ミスとして落とす (fail-closed)
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  // 並列度が 1 未満だと 1 件も処理できない
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`並列度は 1 以上の整数にしてください (指定: ${limit})`);
  }
  // 結果は入力と同じ添字に置く (完了順に押し込むと順序が崩れる)
  const results = new Array<R>(items.length);
  // 次に処理する添字 (各ワーカーが取り合う)
  let next = 0;
  // 1 本ぶんの処理 (空くまで次の添字を取り続ける)
  const runWorker = async (): Promise<void> => {
    // 取れる添字がある限り回す
    for (;;) {
      // 自分の担当を確保する (単一スレッドなのでこの 2 行の間に割り込みは入らない)
      const index = next;
      next += 1;
      // 担当が範囲外なら終わり
      if (index >= items.length) return;
      // 結果を所定の位置へ入れる
      results[index] = await worker(items[index], index);
    }
  };
  // 並列度と件数の小さいほうだけワーカーを立てる
  const workers = Array.from({ length: Math.min(limit, items.length) }, runWorker);
  // すべて終わるまで待つ
  await Promise.all(workers);
  // 入力と同じ順序の結果
  return results;
}

// 長すぎる応答を切り詰める (judge への本文が膨らんでバッチごと失敗するのを防ぐ)
function truncateResponse(text: string): string {
  // 上限以内ならそのまま
  if (text.length <= EVALUATION_RESPONSE_MAX_CHARS) return text;
  // 上限まで切って、切れていることを judge に伝える印を足す
  return `${text.slice(0, EVALUATION_RESPONSE_MAX_CHARS)}${EVALUATION_TRUNCATION_MARK}`;
}

// 配列を決まった大きさの塊に分ける (judge へ渡すバッチを作る)
function chunk<T>(items: readonly T[], size: number): T[][] {
  // 塊を溜める配列
  const chunks: T[][] = [];
  // 先頭から size 件ずつ切り出す
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  // 塊の一覧
  return chunks;
}

/**
 * 評価を 1 回実行する。上流 (エージェント・judge) の接続先は環境変数から決まる
 * (src/lib/proxy/upstream.ts)。**この関数は DB に触らない** — 保存は呼び出し側の責務
 */
export async function runEvaluation(options: {
  // 評価対象エージェントの結線
  agent: AgentTarget;
  // 採点する judge
  judge: JudgeIdentity;
  // 採点するケース (評価セットの並び順)
  cases: readonly EvaluationCaseInput[];
  // 上流の設定 (省略時は process.env)
  env?: NodeJS.ProcessEnv;
}): Promise<EvaluationOutcome> {
  // 使う環境変数
  const env = options.env ?? process.env;
  // ケースが無ければ何もせず空の結果を返す (呼び出し側が 0 件のセットを弾く前提だが fail-safe)
  if (options.cases.length === 0) {
    return { verdicts: [], totals: summarize([]), status: EvaluationRunStatus.completed };
  }

  // 1 段目: ケースごとにエージェントの応答を得る (失敗は null)
  const responses = await mapWithConcurrency(options.cases, EVALUATION_CONCURRENCY, (item) =>
    requestAgentResponse(options.agent, item.input, env),
  );

  // 応答が得られたケースだけを judge へ渡す材料にする
  const judgeInputs: JudgeCaseInput[] = [];
  // 応答が得られなかったケースはここで除外にする
  const preExcluded = new Map<string, CaseVerdict>();
  // ケースと応答を突き合わせる
  options.cases.forEach((item, index) => {
    // そのケースの応答
    const actual = responses[index];
    // 応答が無ければ agent_unavailable で除外 (judge を呼ぶ意味が無い)
    if (actual === null) {
      preExcluded.set(item.caseId, {
        caseId: item.caseId,
        scored: false,
        reason: EvaluationExclusionReason.agent_unavailable,
      });
      return;
    }
    // 採点の材料に入れる (長すぎる応答は切り詰める)
    judgeInputs.push({
      caseId: item.caseId,
      input: item.input,
      expected: item.expected,
      actual: truncateResponse(actual),
    });
  });

  // 2 段目: バッチに分けて judge に採点させる (バッチの失敗は judge_unavailable で除外されて返る)
  const batches = chunk(judgeInputs, EVALUATION_JUDGE_BATCH_SIZE);
  const scoredBatches = await mapWithConcurrency(batches, EVALUATION_CONCURRENCY, (batch) =>
    scoreBatch(options.judge, batch, env),
  );
  // ケース ID から判定を引けるようにする
  const judged = new Map(scoredBatches.flat().map((verdict) => [verdict.caseId, verdict]));

  // 依頼した順に判定を並べ直す。**どのケースにも必ず 1 つの判定を付ける** —
  // 取りこぼすと採点数と除外数の合計がケース数と合わなくなる
  const verdicts = options.cases.map((item): CaseVerdict => {
    // 応答が得られなかったケース
    const excluded = preExcluded.get(item.caseId);
    if (excluded !== undefined) return excluded;
    // judge の判定 (バッチの取りこぼしは judge_unavailable として扱う)
    return (
      judged.get(item.caseId) ?? {
        caseId: item.caseId,
        scored: false,
        reason: EvaluationExclusionReason.judge_unavailable,
      }
    );
  });

  // 集計する
  const totals = summarize(verdicts);
  // 除外が多すぎる実行は採点として使えない
  const status =
    exclusionRate(totals) > EVALUATION_MAX_EXCLUSION_RATE
      ? EvaluationRunStatus.failed
      : EvaluationRunStatus.completed;
  // 実行の結果
  return { verdicts, totals, status };
}
