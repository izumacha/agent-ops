// Route Handler の共通ラッパー: 認証 → ハンドラ本体 → 例外の HTTP 応答化 を 1 か所にまとめる。
// 各ルートは route(async ({ principal, repos, params, request }) => Response) の形で書く
import { DuplicateError, getRepos, type Repositories } from '@/data';
import { isResourceId } from '@/domain/resource-id';
import { API_MESSAGES } from '@/lib/constants';
import { authenticate, type Principal } from './auth';
import { withPrivateCacheHeaders } from './cache-headers';
import { ApiError, errorResponse, notFoundError, validationError } from './errors';
import { HTTP_STATUS } from './http-status';

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

// route() が包んだ関数に付ける印 (テストが Route Handler の結線を綴りに依存せず確かめるのに使う)
export const ROUTE_HANDLER_BRAND = Symbol.for('agent-ops.routeHandler');

// V8 のスタックフレームの形 (末尾が「:行:列)」「:行:列」「<anonymous>)」「native)」のいずれか)
const STACK_FRAME_PATTERN = /^at .*(?::\d+:\d+\)?|<anonymous>\)?|native\)?)$/;

// 内部エラーのログに残す形: 種類 (name / code) と発生箇所 (スタックフレーム) だけで、message は含めない。
// ORM の検証エラーなどは message にクエリ引数 (= メールアドレス・名前といった利用者の入力) をそのまま埋め込むため、
// message ごと出すと PII がログに流れる (§9 ログに残す前に個人情報をマスクする)
function describeError(error: unknown): Record<string, unknown> {
  // Error でなければ型だけ
  if (!(error instanceof Error)) return { type: typeof error };
  // V8 の stack は「name: message」の見出しの後にフレームが続く。見出しは構築時の name / message で固定されるので、
  // まず見出しを長さで切り落とし (message が何行あっても構造で外せる)、残りから V8 のフレームの形
  // (「at 関数 (ファイル:行:列)」か「at <anonymous>」) に一致する行だけを残す。「at 」で始まるかだけで選ぶと、
  // 利用者の入力 (改行を含む description 等) 由来の「at 田中 …」という行が message から紛れ込み、偽のフレームも書ける
  const stack = error.stack ?? '';
  // code は Node のシステムエラー (ECONNREFUSED 等) や ORM のエラー番号が入る
  const code = 'code' in error ? (error as { code?: unknown }).code : undefined;
  // 見出しの形の候補。Node は `TypeError [ERR_INVALID_ARG_TYPE]: …` のように code を挟むことがあり、
  // message が空なら name だけになる
  const headers = [
    `${error.name}: ${error.message}`,
    typeof code === 'string' ? `${error.name} [${code}]: ${error.message}` : null,
    error.name,
  ].filter((candidate): candidate is string => candidate !== null);
  // 実際の stack がどの見出しで始まるか
  const header = headers.find((candidate) => stack.startsWith(candidate));
  // どれとも一致しなければ message の範囲を確定できないので、フレームは 1 行も出さない (fail-closed。
  // 「at …」の形だけで選ぶと、改行を含む利用者の入力由来の行がフレームとして紛れ込む)
  const frames =
    header === undefined
      ? []
      : stack
          .slice(header.length)
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => STACK_FRAME_PATTERN.test(line));
  // 見出しを読めなかったことは残す (フレームが空の理由が分かるように)
  return header === undefined
    ? { name: error.name, code, frames, stackUnparsed: true }
    : { name: error.name, code, frames };
}

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
export function route<P = Record<string, never>>(handler: Handler<P>) {
  // Next.js が呼ぶ形の関数
  const wrapped = async (request: Request, context: RouteContext<P>): Promise<Response> => {
    // 例外はすべて HTTP 応答へ写す
    try {
      // データ層の束 (本番/テストの切り替えは Composition Root が持つ)
      const repos = await getRepos();
      // 認証 (失敗は 401 の ApiError)
      const principal = await authenticate(request, repos);
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
