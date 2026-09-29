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
import { JUDGE_DEFAULT_MODEL, JUDGE_DEFAULT_PROVIDER, JUDGE_MAX_TOKENS } from '@/lib/constants';
import { describeError } from '@/lib/describe-error';
import { buildRequestBody, readResponseText } from '@/lib/llm/messages';
import { callUpstream, resolveUpstreamTarget } from '@/lib/proxy/upstream';

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
  } else if (Object.hasOwn(Provider, providerName)) {
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
    const result = await callUpstream({ provider: judge.provider, target, body });
    // 2xx 以外は採点として使えない (本文の中身は利用者へ出さない)。
    // **ログにステータスを差し込まない** — `console` の実引数は「出してよい形」だけに絞ってあり
    // (tests/error-logging.test.ts)、式を埋める形を 1 か所でも許すと例外の message を埋める形と
    // 区別できなくなる。状況が分かる定型文にする
    if (result.status < 200 || result.status >= 300) {
      console.error('[evaluation] judge が 2xx 以外のステータスを返しました');
      return unavailable();
    }
    // 本文を JSON として読む
    let payload: unknown;
    try {
      payload = JSON.parse(result.body);
    } catch {
      // 上流の応答そのものが JSON でない (プロキシの前段が壊れている等)
      console.error('[evaluation] judge の応答を JSON として解釈できませんでした');
      return unavailable();
    }
    // 応答テキストを取り出す
    const text = readResponseText(judge.provider, payload);
    // 取り出せなければ採点として使えない
    if (text === null) {
      console.error('[evaluation] judge の応答から本文を取り出せませんでした');
      return unavailable();
    }
    // テキストを厳格に読み取って判定にする (不正出力の除外はここで起きる)
    return readJudgeOutput(caseIds, text);
  } catch (error) {
    // 時間切れ・接続不能・設定不足。**詳細はサーバログにだけ残す** (§9)
    console.error('[evaluation] judge の呼び出しに失敗しました:', describeError(error));
    return unavailable();
  }
}
