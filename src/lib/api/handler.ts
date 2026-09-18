// Route Handler の共通ラッパー: 認証 → ハンドラ本体 → 例外の HTTP 応答化 を 1 か所にまとめる。
// 各ルートは route(async ({ principal, repos, params, request }) => Response) の形で書く
import { DuplicateError, getRepos, type Repositories } from '@/data';
import { API_MESSAGES } from '@/lib/constants';
import { authenticate, type Principal } from './auth';
import { ApiError, errorResponse, validationError } from './errors';
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

// 内部エラーのログに残す形: 種類 (name / code) と発生箇所 (スタックフレーム) だけで、message は含めない。
// ORM の検証エラーなどは message にクエリ引数 (= メールアドレス・名前といった利用者の入力) をそのまま埋め込むため、
// message ごと出すと PII がログに流れる (§9 ログに残す前に個人情報をマスクする)
function describeError(error: unknown): Record<string, unknown> {
  // Error でなければ型だけ
  if (!(error instanceof Error)) return { type: typeof error };
  // 「    at ...」の行 (呼び出し位置) だけを残す。1 行目を落とすだけでは複数行の message (ORM のエラーは典型) の
  // 2 行目以降がフレームとして残るため、形で選ぶ
  const frames = (error.stack ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '));
  // code は Node のシステムエラー (ECONNREFUSED 等) や ORM のエラー番号が入る
  const code = 'code' in error ? (error as { code?: unknown }).code : undefined;
  return { name: error.name, code, frames };
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
  // Next.js が呼ぶ形の関数を返す
  return async (request: Request, context: RouteContext<P>): Promise<Response> => {
    // 例外はすべて HTTP 応答へ写す
    try {
      // データ層の束 (本番/テストの切り替えは Composition Root が持つ)
      const repos = await getRepos();
      // 認証 (失敗は 401 の ApiError)
      const principal = await authenticate(request, repos);
      // 動的セグメントを解決する
      const params = await context.params;
      // 本体を実行する
      return await handler({ request, params, principal, repos });
    } catch (error) {
      // 応答に写す
      return toErrorResponse(error);
    }
  };
}

// 204 No Content
export function noContent(): Response {
  // 本文無しの応答
  return new Response(null, { status: HTTP_STATUS.NO_CONTENT });
}
