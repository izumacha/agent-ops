// 応答を数えて例外を HTTP 応答へ写す共通のラッパー（ADR-0014）。
//
// **`handler.ts` から分けてある。** 包むのは `route()` を通る経路だけでなく、通らない経路
// （`GET /health`・受信 Webhook・画面側の CSV・`/metrics` 自身）も同じ 1 本で、あちらは
// 「`route()` の都合を持ち込まない」ために `route()` を避けている経路だ。`handler.ts` に
// 置いていた版では、そこへ取り込むだけで `route()` の推移依存（データ層の Composition Root・
// レート制限・ガード・プランの表）が丸ごと付いてきた。**実測**（`tests/lib/source-files.ts` の
// `sourceImportGraph` で推移的に数えた到達モジュール数）: `/health` が 44 → **20**、
// この分離で `@/data`（Composition Root）が `/health` の連鎖から外れた。`/health` は
// compose の healthcheck が 10 秒ごとに叩き、`bench:demo-ready` が起動時間を測る経路でも
// あるので、モジュール評価の重さが直接響く。`src/lib/log.ts` が import を 2 本に保っている
// のと同じ理由（§8）。
//
// **`/metrics` の数（41）は型だけの import を含む見かけの値**（`sourceImportGraph` は
// `import type` も辺として数える）。`metrics-auth.ts` → `auth.ts` の先で `@/data` を参照して
// いるのは型だけなので、ビルド時に消える。
import { unstable_rethrow } from 'next/navigation';
// 一意制約違反の型だけを**小さなモジュールから**取る（`@/data` は Composition Root なので
// 取り込むとアダプタ一式が付いてくる。ここが欲しいのは例外の種類 1 つだけ）
import { DuplicateError } from '@/data/errors';
import { API_MESSAGES } from '@/lib/constants';
import { ApiError, errorResponse, validationError } from './errors';
import { withPrivateCacheHeaders } from './cache-headers';
import { HTTP_STATUS } from './http-status';
// エラーをログへ落とす形 (経路ごとに書き分けない。src/lib 直下の 1 か所が唯一の定義)
import { describeError } from '@/lib/describe-error';
import { countHttpResponse } from '@/lib/metrics';
import { logEvent } from '@/lib/log';

/**
 * Next.js の制御フローの例外（`redirect()` / `notFound()` / `forbidden()` /
 * `unauthorized()`）かどうかを返す。
 *
 * **判定の規則は上流に任せ、`digest` だけを渡す。** 印の綴り（`NEXT_REDIRECT` /
 * `NEXT_HTTP_ERROR_FALLBACK` と、後者が許す状態コードの集合）を写すと、上流が増やした
 * 種類を取り落とす。`unstable_rethrow` は「制御フローなら投げる・それ以外は戻る」なので、
 * 投げたかどうかで判定できる。
 *
 * **例外そのものを渡さない。** `unstable_rethrow` は最後に `error.cause` を辿るので、
 * `cause` がゲッターなら**判定そのものが投げ**、自分を指していれば `RangeError` になる
 * （どちらも実測。`src/lib/describe-error.ts` が「`'cause' in error` はゲッターを起こさないが
 * 続く読み出しは起こす」と記録しているのと同じ罠）。そうなると応答が組み立てられず、
 * 500 の契約も `api.unexpected_error` のログも `countHttpResponse` もまとめて飛ぶ。
 * **`digest` だけを持つ素のオブジェクト**を渡せば `cause` を辿らない
 * （`instanceof Error` が false になるため）。
 *
 * **代償は 2 つあり、どちらも「見分けられない＝従来どおり 500」側へ倒れる。**
 * 1. 制御フローの例外が**別の例外の `cause` に包まれている**形（上流はそこまで辿る）。
 * 2. **`digest` を見ない判定**は成立しない。上流の 7 本のうち `digest` を見るのは
 *    `isNextRouterError`（`redirect()` / `notFound()` / `forbidden()` / `unauthorized()`）・
 *    `isBailoutToCSRError`・`isDynamicServerError`・`isHangingPromiseRejectionError` で、
 *    残る `isPostpone`（`$$typeof` を見る）・`isDynamicPostpone`（`message` を見る）・
 *    `isPrerenderInterruptedError`（`instanceof Error` ＋ `name` / `message` を要求）は
 *    素のオブジェクトでは false になる。**この 3 本は PPR / `cacheComponents` の prerender 中の
 *    合図**で、`next.config.ts` はどちらも有効にしていないので Route Handler の経路では
 *    起こらない。**有効にするときはここを読み直すこと** — そのままだと prerender の中断が
 *    500 の JSON へ写り、`api.unexpected_error` の警報まで鳴る。
 * @param error 受け取った例外
 * @returns 制御フローの例外なら true
 */
function isNextControlFlowError(error: unknown): boolean {
  // 印を安全に読む（**`cause` には触らない**。ゲッターが投げる形でも判定を壊さない）
  let digest: unknown;
  try {
    // `digest` 自体がゲッターで投げる形もあるので、読み出しも try の中で行う
    digest = (error as { digest?: unknown } | null | undefined)?.digest;
  } catch {
    // 読めないなら印が無いものとして扱う（制御フローではない側＝従来の 500 へ倒す）
    return false;
  }
  // 印は文字列でなければならない（上流の判定と同じ前提）
  if (typeof digest !== 'string') return false;
  try {
    // 上流に判定させる（制御フローなら投げる）
    unstable_rethrow({ digest });
  } catch {
    // 投げた = 制御フローの印だった
    return true;
  }
  // 戻った = 制御フローではない
  return false;
}

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
 * 例外を HTTP 応答へ写す。
 *
 * **このモジュールの外からは呼べない。** 以前は受信 Webhook が自分で呼んでいたが、
 * いまはどの経路も `withResponseCount` を通る。export したままにすると「応答を数えずに
 * 例外だけ写す」公開の入口が残り、次に `route()` を通らない経路を足す人がそちらを呼ぶ誘導に
 * なる（§6 デッドコードを残さない）。写し方を 2 か所に分けないのが要点で、分けると
 * 一意制約違反の 422 への翻訳や 500 のログの有無がずれる。
 */
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
  logEvent('api.unexpected_error', describeError(error));
  return errorResponse(HTTP_STATUS.INTERNAL_SERVER_ERROR, API_MESSAGES.internal);
}

/**
 * その関数が既に応答を数えるラッパーを通っているか（印を読む）。
 * **綴りではなく印を見る** — 検出網と同じ判定にそろえる（`tests/route-wrapping.test.ts`）。
 * @param handler 調べる関数
 * @returns 既に包まれていれば true
 */
function isResponseCounted(handler: unknown): boolean {
  // 関数に付けた印（Symbol）が true かどうか
  return (
    typeof handler === 'function' &&
    (handler as unknown as Record<symbol, unknown>)[RESPONSE_COUNT_BRAND] === true
  );
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
 *   ただし **Next.js の制御フローの例外は写さず投げ直す**（`buildResponse` の説明）。
 * - メソッドは**要求から読む**（`request.method`。文字列を書かない）。
 * @param handler 包む本体（第 1 引数が要求であること）
 * @returns 同じ形の関数（応答を 1 件数えてから返す）
 */
export function withResponseCount<A extends unknown[]>(
  handler: (request: Request, ...rest: A) => Promise<Response>,
): (request: Request, ...rest: A) => Promise<Response> {
  // **二重掛けを素通りさせない。** `withResponseCount(route(handler))` は自然な書き間違い
  // （この PR の 4 本は素の `withResponseCount(...)` を使うし、検出網は全 export に印を
  // 要求する）なのに、内側と外側が同じ応答を 2 度数えて `agentops_http_responses_total` が
  // **実際の 2 倍**を報告する。印は外側に付くので検出網は緑のままで、率の警報が 2 倍ずれる。
  // 既に印の付いた関数が来たらそのまま返す（冪等。包み直す意味は無い）
  if (isResponseCounted(handler)) return handler;
  // Next.js が呼ぶ形の関数
  const counted = async (request: Request, ...rest: A): Promise<Response> => {
    // 応答を組み立てる（例外も応答へ写し、**キャッシュ制御も中で付ける**） —
    // 以前は例外の経路にだけ付けていたので、本体が**返した**早期の 401 / 404 には
    // 付かなかった（画面側の CSV がそれで、認証付きの経路の 401 / 404 が共有キャッシュへ
    // 載りうる状態だった）。**付けるのはここだけ** — `route()` も Webhook も自分で付けていた
    // 頃は、`Vary` が `append` で冪等でないため全 API 応答が
    // `Vary: Authorization, Authorization` を返していた（実測）
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
 *
 * **Next.js の制御フローの例外は写さずに投げ直す。** `redirect()` / `notFound()` /
 * `forbidden()` / `unauthorized()` は「応答を決める」ための例外を投げて止まる仕組みなので、
 * ここで捕まえて 500 の JSON に写すと**遷移も 404 も起きず、`api.unexpected_error` の警報まで
 * 鳴る**（実測: `NEXT_REDIRECT;replace;/login;303;` の digest を持つ例外で 500 と 1 行の
 * ログが出た）。画面の枝で使う `requireSession()`（`src/lib/session-server.ts`）がまさに
 * この 2 つを投げるので、画面側の CSV を `currentSession()` から `requireSession()` へ
 * 寄せる 1 行の整理が「ログイン画面への 303 が 500 に化ける」変更になりうる。
 *
 * **判定は `isNextControlFlowError`**（綴りを写さず上流に判定させるが、例外そのものは渡さない。
 * 理由は同関数の説明）。
 *
 * **ヘッダの押印もこの `try` の中で行う。** 呼び出し側で押していた版では、
 * `withPrivateCacheHeaders` が投げたときに**例外がラッパーの外へ漏れ**、500 の契約も
 * `api.unexpected_error` のログも `countHttpResponse` もまとめて飛んだ（あの関数は
 * `new Response(response.body, …)` で作り直すので、本体が本文ストリームを既に読んだ／
 * 奪われた `Response` を返すと Fetch の仕様どおり `TypeError` になる。差分前の `route()` は
 * 押印を `try` の中に置いていたので 500 へ写っていた）。`catch` の側で押す相手は
 * `toErrorResponse` が作ったばかりの文字列本文なので、同じ壊れ方をしない。
 *
 * 押すのは**この 2 か所だけ**（呼び出し側では押さない）。両方で押していた頃は、エラー応答
 * 1 件につき使い捨ての `Response` を 2 つ作っていた（2 回目は同じ値の上書き＝完全な無駄）。
 * @param run 本体の呼び出し
 * @returns 応答（制御フローの例外は投げ直すので、戻るのは本体の応答かエラー応答だけ）
 */
async function buildResponse(run: () => Promise<Response>): Promise<Response> {
  try {
    // 本体を実行し、そのままヘッダを押す（**押印も try の中**。理由は下記）
    return withPrivateCacheHeaders(await run());
  } catch (error) {
    // Next.js の制御フローの例外なら、ここで止めずに投げ直す
    if (isNextControlFlowError(error)) throw error;
    // それ以外は応答へ写し、同じヘッダを押す（成功の経路と同じ扱い）
    return withPrivateCacheHeaders(toErrorResponse(error));
  }
}
