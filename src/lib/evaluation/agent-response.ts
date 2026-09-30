// 評価対象エージェントに 1 ケース分の入力を投げて応答を得る。judge と同じく
// src/lib/proxy/upstream.ts の結線を使う (接続先の判定を 2 種類持たない)。
//
// **この呼び出しも UsageEvent に記録しない** (ADR-0009)。記録するのはプロキシを通った
// 「利用者の呼び出し」だけで、評価はプラットフォーム側が起こす呼び出しだから
import type { Provider } from '@/domain/types';
import { EVALUATION_AGENT_MAX_TOKENS, EVALUATION_UPSTREAM_TIMEOUT_MS } from '@/lib/constants';
import { describeError } from '@/lib/describe-error';
import { buildRequestBody, readResponseText } from '@/lib/llm/messages';
import { callUpstream, resolveUpstreamTarget } from '@/lib/proxy/upstream';
import { ALWAYS_LOG, type RunLogGate } from './run-log';

/** 応答を得る相手 (評価対象エージェントの結線) */
export interface AgentTarget {
  // エージェントが使うプロバイダ
  provider: Provider;
  // エージェントが使うモデル名
  model: string;
}

/**
 * 1 ケース分の応答を得る。**失敗しても例外を投げず null を返す** —
 * 呼び出し側はそのケースを agent_unavailable として除外し、残りのケースの評価を続ける
 * (受け入れ基準「評価失敗時のフォールバック」)
 */
export async function requestAgentResponse(
  agent: AgentTarget,
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  // 同じ種類のログを 1 実行につき 1 回だけ通す門 (200 件が同じ理由で失敗してもログは 1 行)
  log: RunLogGate = ALWAYS_LOG,
): Promise<string | null> {
  // 上流を呼ぶ
  try {
    // 接続先と資格情報 (設定が無い・安全でなければ ApiError が飛ぶ)
    const target = resolveUpstreamTarget(agent.provider, env);
    // 送る本文 (役割の指示は付けない。評価セットの入力だけを渡す)
    const body = buildRequestBody({
      provider: agent.provider,
      model: agent.model,
      user: input,
      maxTokens: EVALUATION_AGENT_MAX_TOKENS,
    });
    // 応答を得る
    // 1 回あたりの待ち時間は評価用の短い上限にする (実行全体が関数タイムアウトに
    // 届くと、課金されたのに実行の記録が残らない。src/lib/constants.ts の説明を参照)
    const result = await callUpstream({
      provider: agent.provider,
      target,
      body,
      timeoutMs: EVALUATION_UPSTREAM_TIMEOUT_MS,
    });
    // 2xx 以外は応答として使えない。ログにステータスを差し込まない理由は judge.ts と同じ
    // (console の実引数は「出してよい形」だけに絞ってある。tests/error-logging.test.ts)
    if (result.status < 200 || result.status >= 300) {
      if (log.first('agent-status')) {
        console.error('[evaluation] エージェントの上流が 2xx 以外のステータスを返しました');
      }
      return null;
    }
    // 本文を JSON として読む
    let payload: unknown;
    try {
      payload = JSON.parse(result.body);
    } catch {
      // 応答が JSON でない
      if (log.first('agent-json')) {
        console.error('[evaluation] エージェントの応答を JSON として解釈できませんでした');
      }
      return null;
    }
    // 応答テキストを取り出す (読めなければ null のまま返る)
    return readResponseText(agent.provider, payload);
  } catch (error) {
    // 時間切れ・接続不能・設定不足。詳細はサーバログにだけ残す (§9)
    if (log.first('agent-error')) {
      console.error('[evaluation] エージェントの呼び出しに失敗しました:', describeError(error));
    }
    return null;
  }
}
