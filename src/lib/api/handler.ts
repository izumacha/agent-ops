// Route Handler の共通ラッパー: 認証 → ハンドラ本体 → 例外の HTTP 応答化 を 1 か所にまとめる。
// 各ルートは route(async ({ principal, repos, params, request }) => Response) の形で書く
import { DuplicateError, getRepos, type Repositories } from '@/data';
import { isResourceId } from '@/domain/resource-id';
import { API_MESSAGES } from '@/lib/constants';
import { authenticate, authenticateApiKey, type Principal } from './auth';
import { withPrivateCacheHeaders } from './cache-headers';
import { ApiError, errorResponse, notFoundError, validationError } from './errors';
import { enforceRateLimit, type RateLimitTier } from './rate-limit';
import { requireAction, requireAdminRole, requirePlanFeature } from './guard';
import type { Action } from '@/domain/rbac';
import type { PlanFeature } from '@/domain/plan';
import { HTTP_STATUS } from './http-status';
// エラーをログへ落とす形 (経路ごとに書き分けない。src/lib 直下の 1 か所が唯一の定義)
import { describeError } from '@/lib/describe-error';
import { countHttpResponse } from '@/lib/metrics';
import { logEvent } from '@/lib/log';

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
   * 枠の違いは `RATE_LIMIT_TIER` が持つ。**1 要求で上流へ扇状に出る経路には `fanOut`、応答を
   * 返す前に外部の往復を待つ経路には `outbound` を指定する** — 回数だけを数える 1 つの枠では、
   * 1 要求の重さが違う経路に同じ上限を当てても保護にならない
   */
  rateLimit?: RateLimitTier;
  /**
   * レート制限を数える**前に**要求する RBAC の操作 (省略時は route() では確かめない)。
   *
   * **追加の枠 (`fanOut` / `outbound`) を持つルートでは必須**（`tests/route-wrapping.test.ts` が
   * 印から導いて要求する）。理由は順序で、レート制限は認証の後・本体の前に掛かるので、
   * ここで認可しないと**権限の無い利用者がテナント全体の小さい枠を使い切れる** —
   * view しか持たない利用者が `POST /evaluations` を 6 回投げると、どれも本体で 403 になるのに
   * 枠は消費され、同じテナントの operator / admin が窓のあいだ 429 になる（枠はベンダーへの
   * 課金を抑えるためのものなので、**上流へ 1 度も出ない要求で消費されるのは誤り**）。
   *
   * 本体側の `requireAction` は残す（`tenantId` と `user` を取り出すのに要るうえ、
   * ここの宣言を落としたときに認可が丸ごと消えないため。二重に呼んでも副作用は無い）
   */
  requiredAction?: Action;
  /**
   * レート制限を数える**前に** admin ロールを要求するか (省略時は route() では確かめない)。
   *
   * **admin 限定のルートに枠を掛けるときはこちらを使う。** `requiredAction` では表せない —
   * RBAC の許可表に「admin だけが持つ操作」は無く（`view` は 3 役割すべてが持つ）、
   * `requiredAction: 'view'` と書くと **viewer が枠を使い切れる**。実測で、viewer が
   * `GET /audit-logs/verify` を 10 回投げると（どれも本体で 403 になるのに）
   * `heavyRead` の枠が尽き、admin の改ざん確認が 1 分間 429 になった。
   *
   * 本体側の `requireAdminRole` は残す（`tenantId` と `user` を取り出すのに要るうえ、
   * ここの宣言を落としたときに認可が丸ごと消えないため）
   */
  requiredRole?: 'admin';
  /**
   * レート制限を数える**前に**要求する契約プランの機能 (省略時は機能ゲートを掛けない。Step6)。
   *
   * **認可と同じ理由でレート制限より前に置く** — プランで使えない要求が枠を消費すると、
   * 無料プランのテナントが（本体では 403 になる要求で）自分の小さい枠を使い切れる。
   *
   * 本体側の `requirePlanFeature` は残す（`tenantId` と `user` を取り出すのに要るうえ、
   * ここの宣言を落としたときにゲートが丸ごと消えないため。二重に呼んでも副作用は無い）。
   * 宣言漏れは `tests/route-wrapping.test.ts` が**印から導いて**見張る
   */
  requiredPlanFeature?: PlanFeature;
}

// route() が包んだ関数に付ける印 (テストが Route Handler の結線を綴りに依存せず確かめるのに使う)
export const ROUTE_HANDLER_BRAND = Symbol.for('agent-ops.routeHandler');

/**
 * `withResponseCount()` が包んだ関数に付ける印。
 *
 * **ソースの綴りを読む形にしない** — 綴りで照合していた版は、**コメントに関数名が出ているだけで
 * 条件を満たした**（実測: 画面側の CSV を自前で数える形へ戻しても、上に残った説明の
 * `withResponseCount` が綴り検査を満たして全件緑で通った）。印なら値を見るので、
 * コメントも別名の import も関係ない。
 */
export const RESPONSE_COUNT_BRAND = Symbol.for('agent-ops.responseCount');

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
 * そのルートがレート制限より前に要求する RBAC の操作を外から読むための印
 * (宣言していなければ `null`)。
 *
 * 印にするのは `ROUTE_RATE_LIMIT_BRAND` と同じ理由（綴りではなく結線を読む）。
 */
export const ROUTE_REQUIRED_ACTION_BRAND = Symbol.for('agent-ops.routeRequiredAction');

/**
 * そのルートがレート制限より前に要求するロールを外から読むための印
 * （要求しなければ `null`）。`ROUTE_REQUIRED_ACTION_BRAND` と同じ役目で、**admin 限定の
 * ルートはこちら**（RBAC の許可表に「admin だけが持つ操作」が無いため。理由は `requiredRole`）
 */
export const ROUTE_REQUIRED_ROLE_BRAND = Symbol.for('agent-ops.routeRequiredRole');

/**
 * そのルートがレート制限より前に要求する契約プランの機能を外から読むための印
 * （要求しなければ `null`）。他の 3 つと同じ理由で、綴りではなく結線を読む（Step6）
 */
export const ROUTE_REQUIRED_PLAN_FEATURE_BRAND = Symbol.for('agent-ops.routeRequiredPlanFeature');

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

/**
 * 例外を HTTP 応答へ写す。
 *
 * **`route()` を通らない経路（署名付きの受信 Webhook。Step6）も同じ関数を通す** —
 * 写し方を 2 か所に分けると、一意制約違反の 422 への翻訳や 500 のログの有無がずれる。
 */
export function toErrorResponse(error: unknown): Response {
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
  logEvent('api.unexpected_error', describeError(error));
  return errorResponse(HTTP_STATUS.INTERNAL_SERVER_ERROR, API_MESSAGES.internal);
}

/**
 * Route Handler を包んで、**返した応答を 1 件数える**（ADR-0014）。
 *
 * **`route()` を通る経路も通らない経路もこの 1 本を使う。** 以前は数える 3 行を
 * ルートごとに書き写していたので、包む側が毎回 2 つの判断を自分でしていた:
 * (a) 本体を `try` で包むか（包み忘れた画面側の CSV は**例外のときに何も数えず**、
 * その経路の 5xx が系列に一度も現れなかった）、(b) メソッドを何で渡すか
 * （文字列を書いた 3 本は `HEAD` を `GET` として数え、`route()` 側は `other` として
 * 数えていた＝同じ要求が経路で違うラベルになる）。**どちらもここが決めるので、
 * 次に `route()` を通らない経路を足す人は同じ判断をしない。**
 *
 * - 例外は `toErrorResponse` で応答へ写してから数える（写さないと 5xx が現れない）。
 * - メソッドは**要求から読む**（`request.method`。文字列を書かない）。
 * @param handler 包む本体（第 1 引数が要求であること）
 * @returns 同じ形の関数（応答を 1 件数えてから返す）
 */
export function withResponseCount<A extends unknown[]>(
  handler: (request: Request, ...rest: A) => Promise<Response>,
): (request: Request, ...rest: A) => Promise<Response> {
  // Next.js が呼ぶ形の関数
  const counted = async (request: Request, ...rest: A): Promise<Response> => {
    // 応答を組み立てる（例外も応答へ写す）
    const response = await buildResponse(() => handler(request, ...rest));
    // 1 件数える（この呼び出しは例外を投げない。投げると応答が 500 に化ける）
    countHttpResponse(request.method, response.status);
    // 組み立てた応答をそのまま返す
    return response;
  };
  // 「数える経路を通っている」という印を付ける（列挙されない定義なので DTO や JSON には現れない）
  Object.defineProperty(counted, RESPONSE_COUNT_BRAND, { value: true });
  // 包んだ関数を返す
  return counted;
}

/**
 * 本体を呼び、例外を応答へ写す（キャッシュ制御も付ける）。
 * @param run 本体の呼び出し
 * @returns 応答
 */
async function buildResponse(run: () => Promise<Response>): Promise<Response> {
  try {
    // 本体を実行する
    return await run();
  } catch (error) {
    // 例外を応答へ写す（401/403 等もテナント固有なのでキャッシュ禁止のヘッダを付ける）
    return withPrivateCacheHeaders(toErrorResponse(error));
  }
}

/**
 * 認証付き Route Handler を組み立てる。
 * 認証 (401) はどのルートでも本体より前に行い、認可 (403) は本体の先頭で guard.ts を呼ぶ
 */
export function route<P = Record<string, never>>(handler: Handler<P>, options: RouteOptions = {}) {
  // このルートで使う認証関数を決める (指定が無ければユーザートークンの経路)
  const authenticateRequest = options.auth === 'apiKey' ? authenticateApiKey : authenticate;
  // 応答を組み立てる本体（成功も失敗もここで Response になる）
  const respond = async (request: Request, context: RouteContext<P>): Promise<Response> => {
    // 例外はすべて HTTP 応答へ写す
    try {
      // データ層の束 (本番/テストの切り替えは Composition Root が持つ)
      const repos = await getRepos();
      // 認証 (失敗は 401 の ApiError)
      const principal = await authenticateRequest(request, repos);
      // **レート制限は認証の後**に掛ける。キーを認証済みの id から作るので、
      // 偽装できるヘッダ (X-Forwarded-For) に頼らずに数えられる。
      // 認証より前に掛けると、未認証の総当たりで正規の利用者の枠を枯渇させられる
      // **認可はレート制限より先に。** 権限の無い要求で枠を消費させない（理由は requiredAction）
      if (options.requiredAction !== undefined) {
        requireAction(principal, options.requiredAction);
      }
      // admin 限定のルートはロールそのものを確かめる（理由は requiredRole）
      if (options.requiredRole === 'admin') {
        requireAdminRole(principal);
      }
      // プランで可否が決まる機能はここで確かめる（枠を消費する前。理由は requiredPlanFeature）
      if (options.requiredPlanFeature !== undefined) {
        requirePlanFeature(principal, options.requiredPlanFeature);
      }
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
  // Next.js が呼ぶ形の関数。**応答を数えるのは `withResponseCount` の 1 か所**
  // （`route()` を通らない経路も同じ関数を使うので、ラベルの写し方も try の有無も割れない）
  const wrapped = withResponseCount(respond);
  // 「route() が包んだ」という印を付ける (列挙されない定義なので DTO や JSON には現れない)
  Object.defineProperty(wrapped, ROUTE_HANDLER_BRAND, { value: true });
  // レート制限を掛けたかも同じ形で載せる (検出網が結線そのものを読めるようにする)
  Object.defineProperty(wrapped, ROUTE_RATE_LIMIT_BRAND, { value: options.rateLimit ?? null });
  // レート制限より前に要求する操作も同じ形で載せる (検出網が結線そのものを読めるようにする)
  Object.defineProperty(wrapped, ROUTE_REQUIRED_ACTION_BRAND, {
    value: options.requiredAction ?? null,
  });
  Object.defineProperty(wrapped, ROUTE_REQUIRED_ROLE_BRAND, {
    value: options.requiredRole ?? null,
  });
  // プランの機能ゲートも同じ形で載せる（検出網が結線そのものを読めるようにする）
  Object.defineProperty(wrapped, ROUTE_REQUIRED_PLAN_FEATURE_BRAND, {
    value: options.requiredPlanFeature ?? null,
  });
  // 包んだ関数を返す
  return wrapped;
}

// 204 No Content
export function noContent(): Response {
  // 本文無しの応答
  return new Response(null, { status: HTTP_STATUS.NO_CONTENT });
}
