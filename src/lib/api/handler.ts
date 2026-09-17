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

// 例外を HTTP 応答へ写す
function toErrorResponse(error: unknown): Response {
  // 明示的な API エラーはそのまま
  if (error instanceof ApiError) {
    return errorResponse(error.status, error.message, error.issues, error.headers);
  }
  // 一意制約違反は 422 に、どのフィールドかを添える
  if (error instanceof DuplicateError) {
    const translated = validationError([{ path: error.field, message: API_MESSAGES.duplicate }]);
    return errorResponse(translated.status, translated.message, translated.issues);
  }
  // それ以外は内部エラー。応答には出さず、サーバログにはスタックトレースごと残す (§6 文脈を付けてログに残す / §9)
  console.error('[api] 予期しないエラー:', error);
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
