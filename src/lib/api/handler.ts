// Route Handler の共通ラッパー: 認証 → ハンドラ本体 → 例外の HTTP 応答化 を 1 か所にまとめる。
// 各ルートは route(async ({ principal, repos, params, request }) => Response) の形で書く
import { DuplicateError, getRepos, type Repositories } from '@/data';
import { isResourceId } from '@/domain/resource-id';
import { API_MESSAGES } from '@/lib/constants';
import { authenticate, authenticateApiKey, type Principal } from './auth';
import { withPrivateCacheHeaders } from './cache-headers';
import { ApiError, errorResponse, notFoundError, validationError } from './errors';
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
}

// route() が包んだ関数に付ける印 (テストが Route Handler の結線を綴りに依存せず確かめるのに使う)
export const ROUTE_HANDLER_BRAND = Symbol.for('agent-ops.routeHandler');

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
  // 包んだ関数を返す
  return wrapped;
}

// 204 No Content
export function noContent(): Response {
  // 本文無しの応答
  return new Response(null, { status: HTTP_STATUS.NO_CONTENT });
}
