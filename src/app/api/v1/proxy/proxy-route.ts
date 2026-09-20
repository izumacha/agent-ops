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
import { sanitizeUpstreamErrorBody } from '@/lib/proxy/error-body';
import { callUpstream, resolveUpstreamTarget } from '@/lib/proxy/upstream';
import { readUpstreamUsage } from '@/lib/proxy/usage';
import { proxyRequestSchema } from '@/lib/validations/proxy';

// 中継できなかった・計測できなかったときに記録するトークン数 (0)
const NO_TOKENS = 0;
// 同じく記録する料金 (0 マイクロ USD)
const NO_COST = 0n;
// 上流が 5xx を返したかどうかの境目
const SERVER_ERROR_THRESHOLD = 500;
// 上流の応答が 2xx かどうかの上端 (これ未満なら成功として扱う)
const SUCCESS_STATUS_CEILING = 300;

// 写像 1 件の形 (返すステータス・本文の定型文・上流の Retry-After を中継してよいか)
interface MaskedResponse {
  // 利用者へ返すステータス
  status: number;
  // 利用者へ返す定型文 (上流の文章は使わない)
  message: string;
  // 上流の Retry-After を中継してよいか
  relayRetryAfter: boolean;
}

// 上流の応答をそのまま返せないときの、利用者向けの応答。
// **同じ組を何か所にも書かない** (写像の表・5xx・本文が読めないときの 3 か所が引く)
const RELAY_FAILURE: MaskedResponse = {
  status: HTTP_STATUS.BAD_GATEWAY,
  message: API_MESSAGES.upstreamFailure,
  // 混雑ではないので待ち時間の指示は中継しない
  relayRetryAfter: false,
};

/**
 * 上流の応答のうち、**ステータスごと利用者から隠す**もの。
 * 4xx を「送り主自身の本文についての診断」として素通しするのが既定だが、認証・認可・混雑は
 * 送り主ではなく**プラットフォーム側の上流アカウント**の状態を語る。実際に上流は 401 の本文へ
 * 部分マスクした API キーを、429 の本文へ組織名やクォータの状況を載せるため、素通しすると
 * 有効な API キーを持つ全テナントがそれを観測できてしまう (ADR-0007 の決定 7)。
 *
 * **型を Partial にしてあるのは、参照が `undefined` を含むようにするため** — `Record<number, T>` だと
 * 存在しないステータスを引いても型の上では値があることになり、`undefined` の検査を落とす
 * リファクタを型検査が止めてくれない (落とすと通常の 2xx 応答が毎回クラッシュする)
 */
const UPSTREAM_STATUS_MASKING: Readonly<Partial<Record<number, MaskedResponse>>> = {
  // 上流が資格情報を拒否した = こちらの設定の問題。利用者には中継の失敗としてだけ伝える
  [HTTP_STATUS.UNAUTHORIZED]: RELAY_FAILURE,
  // 上流が権限不足を返した場合も同じ (組織やモデルの許可はプラットフォーム側の設定)
  [HTTP_STATUS.FORBIDDEN]: RELAY_FAILURE,
  // 混雑だけは「待てば通る」情報に意味があるので 429 のまま返す (本文は定型文へ差し替える)。
  // **この 1 件だけが上流の Retry-After を中継してよい** — 401/403 でも中継していたときは
  // 「この 502 はバックオフ由来だ」というプラットフォーム側の状態が伝わっていた (実測)
  [HTTP_STATUS.TOO_MANY_REQUESTS]: {
    status: HTTP_STATUS.TOO_MANY_REQUESTS,
    message: API_MESSAGES.upstreamRateLimited,
    relayRetryAfter: true,
  },
};

// 中継してよい Retry-After の形 (RFC 9110 の delay-seconds = 整数の秒数)。
// 上限桁数を決めた固定長の繰り返しなので ReDoS の余地は無い (§9)
const RETRY_AFTER_SECONDS_PATTERN = /^[0-9]{1,7}$/;

// 上流の Retry-After のうち、中継してよい形のものだけを返す (それ以外は undefined)。
// 値を検証せず素通ししていたときは、非数値のバイト列も HTTP-date もそのままクライアントへ届いた (実測)
function relayableRetryAfter(masked: MaskedResponse, value: string | null): string | undefined {
  // 混雑以外では中継しない
  if (!masked.relayRetryAfter) return undefined;
  // ヘッダが無ければ中継しない
  if (value === null) return undefined;
  // 前後の空白を落とす
  const seconds = value.trim();
  // 整数の秒数だけを通す
  return RETRY_AFTER_SECONDS_PATTERN.test(seconds) ? seconds : undefined;
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
        // 応答本文を JSON として読む。**読めたかどうかを真偽値で覚えておく** —
        // `JSON.parse('null')` は成功して null を返すので、値だけでは区別が付かない
        let parsed: unknown = null;
        let bodyIsJson = false;
        try {
          parsed = JSON.parse(result.body);
          bodyIsJson = true;
        } catch {
          // 解釈できない本文 (前段ゲートウェイの HTML のエラーページ、本文を持てない 204/304 の空文字 …)
          bodyIsJson = false;
        }
        // トークン数を読む (読めなければ null)
        const usage = readUpstreamUsage(provider, parsed);
        // 料金を計算する (トークン数が読めなければ 0)
        const cost =
          usage === null
            ? NO_COST
            : (costMicroUsd(provider, body.model, usage.inputTokens, usage.outputTokens) ??
              NO_COST);
        // 記録する (成功・失敗ともに 1 行。ステータスは**実際の上流の値**)
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
        // 成功なのにトークン数を読めなかったことはサーバログに残す (料金 0 の行が黙って増えないように)。
        // **4xx では出さない** — 上流のエラー本文に usage は載らないので必ず読めず、
        // 有効なキーを持つ相手が安く量産できる 400 でログが埋まって本物の異常が隠れる
        if (usage === null && result.status < SUCCESS_STATUS_CEILING) {
          console.error('[proxy] 上流の応答からトークン数を読めませんでした');
        }
        // **本文が JSON として読めなければ、ステータスに関わらず中継しない** (502)。
        // 前段のゲートウェイが返す HTML のエラーページや、本文を持てない 204 / 304 がここに来る
        // (204 を `new Response(body, { status: 204 })` に渡すと TypeError になり、
        //  上流の異常が「自分の内部エラー」= 500 とスタック付きのログに化けていた。実測)。
        // **Content-Type では判定しない** — 前段が付け替えただけの正しい JSON を捨てると、
        // トークン分を記録したのに応答は返さない「課金だけして捨てる」経路になる (実測)
        const masked = !bodyIsJson
          ? RELAY_FAILURE
          : result.status >= SERVER_ERROR_THRESHOLD
            ? RELAY_FAILURE
            : UPSTREAM_STATUS_MASKING[result.status];
        // ステータスごと隠すものは、定型文の応答として返す
        if (masked !== undefined) {
          // 混雑のときだけ、形の整った Retry-After を中継する
          const retryAfter = relayableRetryAfter(masked, result.retryAfter);
          throw new ApiError(
            masked.status,
            masked.message,
            undefined,
            retryAfter === undefined ? undefined : { 'Retry-After': retryAfter },
          );
        }
        // 2xx はそのまま返し、素通しする 4xx は**機械可読な項目だけ**に絞ってから返す。
        // 上流の自由記述には残高不足・組織名・契約ティアが載るので、ステータス番号では選り分けられない
        // (ADR-0007 決定 7。絞り込みの規則は src/lib/proxy/error-body.ts)
        const relayedBody =
          result.status < SUCCESS_STATUS_CEILING
            ? result.body
            : JSON.stringify(sanitizeUpstreamErrorBody(parsed));
        // 上流の応答を返す (ヘッダは content-type だけ。上流のヘッダは転送しない)
        return new Response(relayedBody, {
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
