// judge (採点用 LLM) の結線。**接続先と資格情報はプロキシと同じ経路で決める**
// (src/lib/proxy/upstream.ts)。judge だけ別の結線を持つと、SSRF 対策や https の制約が
// 片方にしか掛からない状態が静かにできる。
//
// **judge の呼び出しは UsageEvent に記録しない** (ADR-0009)。UsageEvent は「エージェントの
// LLM 呼び出し 1 回 = 1 行」で agentId が必須であり、judge はプラットフォーム側の処理なので、
// 混ぜると日次集計が評価実行のたびに跳ね、Step4 のコスト超過ルールが評価のせいで発火しうる
import { readJudgeOutput, type CaseVerdict } from '@/domain/evaluation/judge-output';
import {
  buildJudgeUserPrompt,
  JUDGE_SYSTEM_PROMPT,
  type JudgeCaseInput,
} from '@/domain/evaluation/prompt';
import { EvaluationExclusionReason, Provider } from '@/domain/types';
import {
  EVALUATION_UPSTREAM_TIMEOUT_MS,
  JUDGE_DEFAULT_MODEL,
  JUDGE_DEFAULT_PROVIDER,
  JUDGE_MAX_TOKENS,
} from '@/lib/constants';
import { describeError } from '@/lib/describe-error';
import { buildRequestBody, readResponseText } from '@/lib/llm/messages';
import { ALWAYS_LOG, type RunLogGate } from './run-log';
import { callUpstream, resolveUpstreamTarget } from '@/lib/proxy/upstream';
import { logEvent } from '@/lib/log';

// プロバイダとして受け付ける値の一覧 (綴りの照合に使う。src/lib/validations/common.ts の
// provider スキーマと同じく「値」から導き、キーの綴りには頼らない)
const PROVIDER_VALUES: readonly Provider[] = Object.values(Provider);

/** どの judge が採点したか (EvaluationRun に残す) */
export interface JudgeIdentity {
  // judge のプロバイダ
  provider: Provider;
  // judge のモデル名
  model: string;
}

/**
 * 環境変数から judge のプロバイダとモデルを決める。指定が無ければ定数の既定値。
 * **未知のプロバイダ名は既定へ倒さず null を返す** — 綴りを間違えた設定で「意図しない
 * プロバイダに採点させる」ほうが、設定ミスとして止まるより危ない (fail-closed)
 */
export function resolveJudgeIdentity(env: NodeJS.ProcessEnv = process.env): JudgeIdentity | null {
  // プロバイダの指定 (空文字は未設定と同じ扱い)
  const providerName = env.JUDGE_PROVIDER?.trim();
  // 指定が無ければ既定、あれば enum に載っているかを確かめる
  let provider: Provider;
  if (providerName === undefined || providerName === '') {
    provider = JUDGE_DEFAULT_PROVIDER;
  } else if (PROVIDER_VALUES.includes(providerName as Provider)) {
    // **キーではなく「値」の一覧で照合する** — Provider はいまキーと値が同じ綴りだが、
    // 値だけを変えた瞬間にキー照合は「通るのに Provider ではない文字列」を作り、
    // 上流の結線 (UPSTREAMS[provider]) が undefined になって落ちるうえ、
    // その文字列が Prisma の enum 列へそのまま書かれる
    provider = providerName as Provider;
  } else {
    // 知らないプロバイダ名は設定ミス
    return null;
  }
  // モデルの指定 (空文字は未設定と同じ扱い)
  const model = env.JUDGE_MODEL?.trim();
  // 指定が無ければ既定のモデル
  return { provider, model: model === undefined || model === '' ? JUDGE_DEFAULT_MODEL : model };
}

/**
 * 1 バッチ分のケースを judge に採点させる。
 * **どんな失敗でも例外を投げず、そのバッチを judge_unavailable で除外して返す** —
 * 受け入れ基準「評価失敗時のフォールバック」がこれ。1 バッチの失敗で実行全体を落とすと、
 * 残りのケースの採点まで捨てることになる
 */
export async function scoreBatch(
  judge: JudgeIdentity,
  cases: readonly JudgeCaseInput[],
  env: NodeJS.ProcessEnv = process.env,
  // 同じ種類のログを 1 実行につき 1 回だけ通す門 (バッチが全部同じ理由で失敗してもログは 1 行)
  log: RunLogGate = ALWAYS_LOG,
): Promise<CaseVerdict[]> {
  // 依頼するケース ID (判定の順序と件数の基準になる)
  const caseIds = cases.map((item) => item.caseId);
  // バッチが空なら呼ぶ必要がない
  if (caseIds.length === 0) return [];
  // 失敗したときに返す形 (全件を judge_unavailable で除外)
  const unavailable = (): CaseVerdict[] =>
    caseIds.map((caseId) => ({
      caseId,
      scored: false,
      reason: EvaluationExclusionReason.judge_unavailable,
    }));
  // 上流を呼ぶ
  try {
    // 接続先と資格情報 (設定が無い・安全でなければ ApiError が飛ぶ)
    const target = resolveUpstreamTarget(judge.provider, env);
    // 送る本文を組み立てる
    const body = buildRequestBody({
      provider: judge.provider,
      model: judge.model,
      system: JUDGE_SYSTEM_PROMPT,
      user: buildJudgeUserPrompt(cases),
      maxTokens: JUDGE_MAX_TOKENS,
    });
    // 採点させる
    // 1 回あたりの待ち時間は評価用の短い上限にする (実行全体が関数タイムアウトに
    // 届くと、課金されたのに実行の記録が残らない。src/lib/constants.ts の説明を参照)
    const result = await callUpstream({
      provider: judge.provider,
      target,
      body,
      timeoutMs: EVALUATION_UPSTREAM_TIMEOUT_MS,
    });
    // 2xx 以外は採点として使えない (本文の中身は利用者へ出さない)。
    // **ログにステータスを差し込まない** — 出来事は閉じた語彙（`LOG_EVENTS`）で名乗り、添えられるのは
    // `describeError(...)` の診断だけ (tests/error-logging.test.ts)。可変の値を 1 か所でも許すと
    // 例外の message を埋める形と区別できなくなる。状況が分かるだけの出来事の名前にする
    if (result.status < 200 || result.status >= 300) {
      if (log.first('judge-status')) {
        logEvent('evaluation.judge_status_not_2xx');
      }
      return unavailable();
    }
    // 本文を JSON として読む
    let payload: unknown;
    try {
      payload = JSON.parse(result.body);
    } catch {
      // 上流の応答そのものが JSON でない (プロキシの前段が壊れている等)
      if (log.first('judge-json')) {
        logEvent('evaluation.judge_body_not_json');
      }
      return unavailable();
    }
    // 応答テキストを取り出す
    const text = readResponseText(judge.provider, payload);
    // 取り出せなければ採点として使えない
    if (text === null) {
      if (log.first('judge-text')) {
        logEvent('evaluation.judge_text_missing');
      }
      return unavailable();
    }
    // テキストを厳格に読み取って判定にする (不正出力の除外はここで起きる)
    return readJudgeOutput(caseIds, text);
  } catch (error) {
    // 時間切れ・接続不能・設定不足。**詳細はサーバログにだけ残す** (§9)
    if (log.first('judge-error')) {
      logEvent('evaluation.judge_call_failed', describeError(error));
    }
    return unavailable();
  }
}
