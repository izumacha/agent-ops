// API のエラー表現。Route Handler は ApiError を throw し、handler.ts が JSON 応答へ写す
import type { ApiErrorDto } from '@/lib/api-types';
import { API_MESSAGES } from '@/lib/constants';
import { HTTP_STATUS } from './http-status';

// 入力検証の詳細 (OpenAPI の Error.issues と同じ形)
export type ApiIssue = { path: string; message: string };

// HTTP ステータス付きの例外
export class ApiError extends Error {
  // HTTP ステータス
  readonly status: number;
  // 入力検証の詳細 (422 のとき)
  readonly issues?: ApiIssue[];
  // 応答に付ける追加ヘッダ (401 の WWW-Authenticate など)
  readonly headers?: Record<string, string>;

  // ステータス・利用者向け文言・任意の詳細・追加ヘッダを受け取る
  constructor(
    status: number,
    message: string,
    issues?: ApiIssue[],
    headers?: Record<string, string>,
  ) {
    // 文言を親クラスへ
    super(message);
    // 名前を型名に合わせる
    this.name = 'ApiError';
    // ステータスと詳細を保持する
    this.status = status;
    this.issues = issues;
    this.headers = headers;
  }
}

// OpenAPI の Error スキーマに沿った JSON 応答を作る
export function errorResponse(
  status: number,
  message: string,
  issues?: ApiIssue[],
  headers?: Record<string, string>,
): Response {
  // issues は 422 のときだけ載せる (undefined のキーは JSON に出ない)
  const body: ApiErrorDto = { status, message, ...(issues ? { issues } : {}) };
  // JSON で返す (追加ヘッダがあれば付ける)
  return Response.json(body, { status, headers });
}

// よく使う例外の生成ヘルパー (文言は constants.ts の API_MESSAGES から引く)

// 404: 見つからない (他テナントの資源もこれで隠す)
export function notFoundError(): ApiError {
  // 存在の有無を区別しない固定文言
  return new ApiError(HTTP_STATUS.NOT_FOUND, API_MESSAGES.notFound);
}

// 422: 入力検証エラー (どのフィールドが・なぜ を issues で伝える)
export function validationError(issues: ApiIssue[]): ApiError {
  // 共通の文言に詳細を添える
  return new ApiError(HTTP_STATUS.UNPROCESSABLE_ENTITY, API_MESSAGES.validation, issues);
}

// 409: 現在の状態では実行できない
export function conflictError(message: string): ApiError {
  // 理由は呼び出し側が文言表から選ぶ
  return new ApiError(HTTP_STATUS.CONFLICT, message);
}
