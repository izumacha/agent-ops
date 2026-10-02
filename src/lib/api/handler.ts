// Route Handler の共通ラッパー: 認証 → ハンドラ本体 → 例外の HTTP 応答化 を 1 か所にまとめる。
// 各ルートは route(async ({ principal, repos, params, request }) => Response) の形で書く
import { DuplicateError, getRepos, type Repositories } from '@/data';
import { isResourceId } from '@/domain/resource-id';
import { API_MESSAGES } from '@/lib/constants';
import { authenticate, authenticateApiKey, type Principal } from './auth';
import { withPrivateCacheHeaders } from './cache-headers';
import { ApiError, errorResponse, notFoundError, validationError } from './errors';
import { enforceRateLimit, type RateLimitTier } from './rate-limit';
import { HTTP_STATUS } from './http-status';
// エラーをログへ落とす形 (経路ごとに書き分けない。src/lib 直下の 1 か所が唯一の定義)
import { describeError } from '@/lib/describe-error';

// Next.js 16 の Route Handler が受け取る第 2 引数 (動的セグメントは Promise で届く)
export interface RouteContext<P> {
  params: Promise<P>;
}

// ハンドラ本体が受け取る材料
export interface HandlerInput<P> {
  // 元のリクエスト
  request: Request;
  // 解決済みの動的セグメント
  params: P;
  // 認証済みの主体
  principal: Principal;
  // データ層 (本番は prisma、テストは memory)
  repos: Repositories;
}

// ハンドラ本体の型
export type Handler<P> = (input: HandlerInput<P>) => Promise<Response>;

/**
 * そのルートが受け付ける資格情報の種類。
 * 'user' (既定) はユーザートークンとプラットフォーム管理者トークン、'apiKey' は API キーだけ。
 * **既定を 'user' にしてあるのが要点** — 新しいルートを足した人が何も書かなければ、
 * プロキシ専用の API キーでは呼べない側に倒れる (ADR-0005 / ADR-0007)
 */
export type RouteAuth = 'user' | 'apiKey';

// route() の任意設定
export interface RouteOptions {
  // 受け付ける資格情報の種類 (省略時は 'user')
  auth?: RouteAuth;
  /**
   * レート制限を掛けるか、掛けるならどの枠で数えるか (省略時は掛けない)。
   *
   * **既定を「掛けない」にしてあるのは、掛け忘れが 429 ではなく「制限なし」に倒れるから**で、
   * 本来は逆向き (fail-closed) が望ましい。それでも既定を off にしているのは、全ルートに
   * 掛けると一覧の読み出しのような安いルートまで同じ枠を食い、**上流へ出る中継の枠を
   * 画面の描画が奪う**形になるため。掛ける対象は「外部へ費用を発生させる経路」に絞る。
   * 掛け忘れは `tests/route-wrapping.test.ts` が **import の連鎖から導いて**見張る —
   * 「上流 LLM を呼ぶモジュール (`src/lib/proxy/upstream.ts`) へ到達するルートの非 GET は
   * 必ずこの指定を持つ」。手書きの一覧ではなくコードの連鎖から導くので、上流を呼ぶルートを
   * 新しく足した人が指定を忘れたら落ちる。
   *
   * 枠の違いは `RATE_LIMIT_TIER` が持つ。**1 要求で何十回も外へ出る経路には `heavy` を指定する** —
   * 回数だけを数える枠では、1 要求の重さが 2 桁違う経路に同じ上限を当てても保護にならない
   */
  rateLimit?: RateLimitTier;
}

// route() が包んだ関数に付ける印 (テストが Route Handler の結線を綴りに依存せず確かめるのに使う)
export const ROUTE_HANDLER_BRAND = Symbol.for('agent-ops.routeHandler');

/**
 * そのルートがどの枠でレート制限を掛けているかを外から読むための印
 * (掛けていなければ `null`、掛けていれば `RateLimitTier` の値)。
 *
 * **ソースの綴りを読む形にしない** — `route(handler, OPTIONS)` のように設定を変数へ出す・
 * 展開する・別名で渡すといった書き方がすべて死角になる (`ROUTE_HANDLER_BRAND` を
 * 実体から読んでいるのと同じ理由)。実際に包まれた関数に値として載せれば、
 * 検出網は「何と書いてあるか」ではなく「どう結線されたか」を見られる。
 *
 * **真偽値ではなく枠の種類を載せる** — 「掛かっているか」だけを載せると、重い経路の指定を
 * `standard` へ落とす変更が検出網から見えない (印は true のままなので)
 */
export const ROUTE_RATE_LIMIT_BRAND = Symbol.for('agent-ops.routeRateLimit');

/**
 * URL の動的セグメント (パスに現れる id) の形を確かめる。形が違えばそんな資源は存在しないので 404。
 *
 * Next.js はパスセグメントを percent-decode してから渡すので、`/agents/%00` は NUL を含む文字列として
 * ここへ届く。素通しすると PostgreSQL が 0x00 を含む text を拒否して 500 になり、認証さえ通れば
 * 最小権限の viewer でも 500 とスタックのログを無制限に積める (実測)。**この壊れ方は API テストからは
 * 見えない** — memory アダプタでは「表に無い」だけなので同じ入力が 404 に見える (ADR-0006 の死角)。
 *
 * 判定はルートごとではなく route() の中で全セグメントに掛ける。ルートが増えても書き足す場所が無いので、
 * 新しい `[id]` を足した人が検証を忘れることが起きない (Step1 の動的セグメントはすべて資源 id)。
 */
function assertResourceIdParams(params: unknown): void {
  // 動的セグメントを持たないルートは何も見ない
  if (typeof params !== 'object' || params === null) return;
  // どの値も資源 id の形であること (配列で届く catch-all セグメントも isResourceId が false にする)
  for (const value of Object.values(params)) {
    if (!isResourceId(value)) throw notFoundError();
  }
}

// 例外を HTTP 応答へ写す
function toErrorResponse(error: unknown): Response {
  // 明示的な API エラーはそのまま (ApiError → Response の写しはここ 1 か所)
  if (error instanceof ApiError) {
    return errorResponse(error.status, error.message, error.issues, error.headers);
  }
  // 一意制約違反は 422 の ApiError に翻訳してから同じ経路で写す (どのフィールドかを添える)
  if (error instanceof DuplicateError) {
    return toErrorResponse(
      validationError([{ path: error.field, message: API_MESSAGES.duplicate }]),
    );
  }
  // それ以外は内部エラー。応答には出さず、サーバログに残す (§6 文脈を付けてログに残す / §9)
  console.error('[api] 予期しないエラー:', describeError(error));
  return errorResponse(HTTP_STATUS.INTERNAL_SERVER_ERROR, API_MESSAGES.internal);
}

/**
 * 認証付き Route Handler を組み立てる。
 * 認証 (401) はどのルートでも本体より前に行い、認可 (403) は本体の先頭で guard.ts を呼ぶ
 */
export function route<P = Record<string, never>>(handler: Handler<P>, options: RouteOptions = {}) {
  // このルートで使う認証関数を決める (指定が無ければユーザートークンの経路)
  const authenticateRequest = options.auth === 'apiKey' ? authenticateApiKey : authenticate;
  // Next.js が呼ぶ形の関数
  const wrapped = async (request: Request, context: RouteContext<P>): Promise<Response> => {
    // 例外はすべて HTTP 応答へ写す
    try {
      // データ層の束 (本番/テストの切り替えは Composition Root が持つ)
      const repos = await getRepos();
      // 認証 (失敗は 401 の ApiError)
      const principal = await authenticateRequest(request, repos);
      // **レート制限は認証の後**に掛ける。キーを認証済みの id から作るので、
      // 偽装できるヘッダ (X-Forwarded-For) に頼らずに数えられる。
      // 認証より前に掛けると、未認証の総当たりで正規の利用者の枠を枯渇させられる
      // 指定があれば、その枠で数えて上限を超えていれば 429 (Retry-After 付き) を投げる
      if (options.rateLimit !== undefined) {
        enforceRateLimit(principal, options.rateLimit, Date.now());
      }
      // 動的セグメントを解決する
      const params = await context.params;
      // 資源 id の形でないセグメントは本体へ渡さず 404 にする (DB へ渡すと 500 になる値を入口で止める)
      assertResourceIdParams(params);
      // 本体を実行する (応答にはキャッシュ禁止のヘッダを付ける)
      return withPrivateCacheHeaders(await handler({ request, params, principal, repos }));
    } catch (error) {
      // 応答に写す (401/403 等もテナント固有なので同じヘッダを付ける)
      return withPrivateCacheHeaders(toErrorResponse(error));
    }
  };
  // 「route() が包んだ」という印を付ける (列挙されない定義なので DTO や JSON には現れない)
  Object.defineProperty(wrapped, ROUTE_HANDLER_BRAND, { value: true });
  // レート制限を掛けたかも同じ形で載せる (検出網が結線そのものを読めるようにする)
  Object.defineProperty(wrapped, ROUTE_RATE_LIMIT_BRAND, { value: options.rateLimit ?? null });
  // 包んだ関数を返す
  return wrapped;
}

// 204 No Content
export function noContent(): Response {
  // 本文無しの応答
  return new Response(null, { status: HTTP_STATUS.NO_CONTENT });
}
