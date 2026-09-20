// プロキシのルート本体 (Anthropic / OpenAI で共通)。プロバイダごとの違い (接続先・パス・usage の項目名) は
// src/lib/proxy/* に閉じているので、ここは「認証 → 検証 → 中継 → 記録 → 応答」の順番だけを持つ。
//
// 記録についての約束 (docs/adr/0007-cost-proxy.md):
//   - 成功も失敗も 1 行記録する (Step4 のエラー率ルールが読む)
//   - 記録に失敗しても中継結果は返す (記録のために成功した呼び出しを捨てない。失敗はサーバログへ)
//   - 料金表に無いモデルは中継しない (計れない呼び出しを 0 円で記録しない)
import type { Repositories } from '@/data';
import { costMicroUsd, findModelPrice } from '@/domain/pricing';
import type { Provider } from '@/domain/types';
import { API_MESSAGES } from '@/lib/constants';
import { readJsonBody } from '@/lib/api/body';
import { ApiError, validationError } from '@/lib/api/errors';
import { requireProxyAgent } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { callUpstream, resolveUpstreamTarget } from '@/lib/proxy/upstream';
import { readUpstreamUsage } from '@/lib/proxy/usage';
import { proxyRequestSchema } from '@/lib/validations/proxy';

// 中継できなかった・計測できなかったときに記録するトークン数 (0)
const NO_TOKENS = 0;
// 同じく記録する料金 (0 マイクロ USD)
const NO_COST = 0n;
// 上流が 5xx を返したかどうかの境目
const SERVER_ERROR_THRESHOLD = 500;

/**
 * 上流の応答のうち、**本文をそのまま返してはいけない**ステータス。
 * 4xx を「送り主自身の本文についての診断」として素通しするのが既定だが、認証・認可・混雑は
 * 送り主ではなく**プラットフォーム側の上流アカウント**の状態を語る。実際に上流は 401 の本文へ
 * 部分マスクした API キーを、429 の本文へ組織名やクォータの状況を載せるため、素通しすると
 * 有効な API キーを持つ全テナントがそれを観測できてしまう (ADR-0007 の決定 7)
 */
const UPSTREAM_STATUS_MASKING: Readonly<Record<number, { status: number; message: string }>> = {
  // 上流が資格情報を拒否した = こちらの設定の問題。利用者には中継の失敗としてだけ伝える
  [HTTP_STATUS.UNAUTHORIZED]: {
    status: HTTP_STATUS.BAD_GATEWAY,
    message: API_MESSAGES.upstreamFailure,
  },
  // 上流が権限不足を返した場合も同じ (組織やモデルの許可はプラットフォーム側の設定)
  [HTTP_STATUS.FORBIDDEN]: {
    status: HTTP_STATUS.BAD_GATEWAY,
    message: API_MESSAGES.upstreamFailure,
  },
  // 混雑だけは「待てば通る」情報に意味があるので 429 のまま返す (本文は定型文へ差し替える)
  [HTTP_STATUS.TOO_MANY_REQUESTS]: {
    status: HTTP_STATUS.TOO_MANY_REQUESTS,
    message: API_MESSAGES.upstreamRateLimited,
  },
};

// 上流の応答が JSON かどうか (パラメータ付き `application/json; charset=utf-8` も許す)。
// ベンダーの JSON API は `application/json` 系しか返さないので、それ以外は異常として扱う
function isJsonMediaType(contentType: string | null): boolean {
  // ヘッダが無ければ JSON とみなさない (fail-closed)
  if (contentType === null) return false;
  // パラメータを落として比較する
  return contentType.split(';')[0].trim().toLowerCase() === 'application/json';
}

// 利用イベントを 1 行記録する。**失敗しても投げない** (中継そのものは成功しているため)
async function recordUsage(
  repos: Repositories,
  input: {
    tenantId: string;
    agentId: string;
    provider: Provider;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costMicroUsd: bigint;
    latencyMs: number;
    statusCode: number;
  },
): Promise<void> {
  // 記録を試みる
  try {
    // 記録する (エージェントが同テナントに無ければ null が返る)
    const recorded = await repos.usageEvents.record(input);
    // 記録できなかったのは想定外 (認証時に同テナントのエージェントだと確かめている) なので残す
    if (recorded === null) {
      console.error('[proxy] 利用イベントを記録できませんでした (エージェントが見つかりません)');
    }
  } catch (error) {
    // DB の障害などで記録できなくても中継は成立しているので、ログだけ残して続ける
    console.error(
      '[proxy] 利用イベントの記録に失敗しました:',
      error instanceof Error ? error.name : typeof error,
    );
  }
}

/**
 * 1 プロバイダ分のプロキシ Route Handler を組み立てる。
 * **認証は API キーだけ** (route の auth: 'apiKey')。ユーザートークンでは 401 になる
 */
export function proxyRoute(provider: Provider) {
  // route() で包んだハンドラを返す (各 route.ts はこれを再エクスポートするだけ)
  return route(
    async ({ request, principal, repos }) => {
      // API キーで認証されたエージェント (停止中・キー失効はここまでに 401/403 で弾かれている)
      const { agent, tenantId } = requireProxyAgent(principal);
      // 本文を検証する (415 → 413 → 400 → 422 の順。未知キーはベンダーのパラメータとして通す)
      const body = await readJsonBody(request, proxyRequestSchema);
      // 料金表に無いモデルは計測できないので中継しない (0 円の行を作らない)
      if (findModelPrice(provider, body.model) === null) {
        throw validationError([{ path: 'model', message: API_MESSAGES.unsupportedModel }]);
      }
      // 検証済みの本文を組み立て直して送る (受け取ったバイト列をそのまま流さないので、
      // 本文の前後に紛れ込んだ余計なバイトが上流へ届かない)。
      // **JSON として作り直すので値の正規化が起きる**: 2^53 を超える整数は丸められ
      // (実測: 12345678901234567890 → 12345678901234567000)、`1e400` は null、`-0` は 0 になる。
      // 実害が出るのは `seed` に巨大な整数を渡すような限られた使い方だけなので受け入れ、
      // OpenAPI の説明にも同じ断りを書いている
      const payload = JSON.stringify(body);
      // 中継先と資格情報を先に決める。**記録の外側で決めるのが要点** — 設定が無くて 503 になる場合は
      // 上流へ 1 バイトも出ていないので、利用イベントを記録しない (記録するのは実際に出た呼び出しだけ)。
      // 記録の中で決めていたときは、上流未設定のあいだ有効なキー 1 本で DB 行だけを無制限に増やせた (実測)
      const target = resolveUpstreamTarget(provider);
      // 上流の呼び出しにかかった時間を測る (記録する latencyMs の定義はこの 1 か所)
      const startedAt = performance.now();
      // この呼び出しを既に記録したか。**ステータスでは判定しない** — 上流の 5xx を 502 に写したときと
      // 上流へ接続できなかったときは同じ 502 になるので、「502 なら記録済み」とすると後者が記録から漏れる (実測)
      let alreadyRecorded = false;
      // 中継の結果 (例外は下で捕まえる)
      try {
        // 上流を呼ぶ
        const result = await callUpstream({ provider, target, body: payload });
        // かかった時間
        const latencyMs = Math.round(performance.now() - startedAt);
        // 上流の応答のうち、本文を返してはいけないもの (401 / 403 / 429) と 5xx は、
        // 利用者向けの定型文へ写してから返す。記録は**実際の上流のステータス**で残す
        const masked =
          result.status >= SERVER_ERROR_THRESHOLD
            ? { status: HTTP_STATUS.BAD_GATEWAY, message: API_MESSAGES.upstreamFailure }
            : UPSTREAM_STATUS_MASKING[result.status];
        if (masked !== undefined) {
          // 記録してから
          await recordUsage(repos, {
            tenantId,
            agentId: agent.id,
            provider,
            model: body.model,
            inputTokens: NO_TOKENS,
            outputTokens: NO_TOKENS,
            costMicroUsd: NO_COST,
            latencyMs,
            statusCode: result.status,
          });
          // 記録済みの印を立ててから、定型文の応答として返す。
          // 混雑 (429) のときだけ上流の Retry-After を中継する (待ち時間そのものは
          // プラットフォーム側の情報を漏らさず、クライアントの再試行嵐を防ぐ)
          alreadyRecorded = true;
          throw new ApiError(
            masked.status,
            masked.message,
            undefined,
            result.retryAfter === null ? undefined : { 'Retry-After': result.retryAfter },
          );
        }
        // 応答本文を JSON として読む (2xx でも壊れていれば usage は読めない)
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(result.body);
        } catch {
          // 解釈できない本文は「計測できなかった呼び出し」として扱う (そのまま中継はする)
          parsed = null;
        }
        // トークン数を読む (読めなければ null)
        const usage = readUpstreamUsage(provider, parsed);
        // 読めなかったことはサーバログに残す (料金 0 の行が黙って増えないように)。
        // ここへ来る時点で 5xx は上で返しているので、ステータスの条件は足さない (常に真になる)
        if (usage === null) {
          console.error('[proxy] 上流の応答からトークン数を読めませんでした');
        }
        // 料金を計算する (トークン数が読めなければ 0)
        const cost =
          usage === null
            ? NO_COST
            : (costMicroUsd(provider, body.model, usage.inputTokens, usage.outputTokens) ??
              NO_COST);
        // 記録する (成功・4xx ともに 1 行)
        alreadyRecorded = true;
        await recordUsage(repos, {
          tenantId,
          agentId: agent.id,
          provider,
          model: body.model,
          inputTokens: usage?.inputTokens ?? NO_TOKENS,
          outputTokens: usage?.outputTokens ?? NO_TOKENS,
          costMicroUsd: cost,
          latencyMs,
          statusCode: result.status,
        });
        // 上流が JSON 以外 (前段のゲートウェイが返す HTML のエラーページ等) を返したときは、
        // 本文を返さず 502 にする。**JSON だと名乗って HTML を返さない** —
        // クライアントの JSON 解釈が理由不明で失敗するうえ、中身は上流側の内部情報でもある
        if (!isJsonMediaType(result.contentType)) {
          throw new ApiError(HTTP_STATUS.BAD_GATEWAY, API_MESSAGES.upstreamFailure);
        }
        // 上流の応答をそのまま返す (ヘッダは content-type だけ。上流のヘッダは転送しない)
        return new Response(result.body, {
          status: result.status,
          headers: { 'content-type': 'application/json' },
        });
      } catch (error) {
        // 中継そのものが失敗した場合 (時間切れ 504 / 接続不能 502 / 未設定 503) も記録を残す。
        // 既に記録した呼び出し (上流の 5xx を 502 へ写した経路) は二重に記録しない
        if (error instanceof ApiError && !alreadyRecorded) {
          await recordUsage(repos, {
            tenantId,
            agentId: agent.id,
            provider,
            model: body.model,
            inputTokens: NO_TOKENS,
            outputTokens: NO_TOKENS,
            costMicroUsd: NO_COST,
            latencyMs: Math.round(performance.now() - startedAt),
            statusCode: error.status,
          });
        }
        // 例外はそのまま上へ (route() が HTTP 応答へ写す)
        throw error;
      }
    },
    // このルートは API キーでしか呼べない
    { auth: 'apiKey' },
  );
}
