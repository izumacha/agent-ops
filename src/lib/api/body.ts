// リクエスト本文の読み取りと検証 (Content-Type・サイズ上限・JSON 構文・Zod スキーマ)
import type { ZodType } from 'zod';
import { API_MESSAGES, JSON_BODY_MAX_BYTES } from '@/lib/constants';
import { ApiError, type ApiIssue } from './errors';

// HTTP ステータス
const BAD_REQUEST = 400;
const PAYLOAD_TOO_LARGE = 413;
const UNSUPPORTED_MEDIA_TYPE = 415;
const UNPROCESSABLE = 422;
// 受け付けるメディア型
const JSON_MEDIA_TYPE = 'application/json';

// Zod の検証失敗を OpenAPI の issues 形式へ写す
export function toIssues(error: {
  issues: { path: PropertyKey[]; message: string }[];
}): ApiIssue[] {
  // path は配列なので '.' で繋ぎ、message はそのまま
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

// 検証済みの値を返す共通関数 (クエリ・本文どちらにも使う)
export function validateWith<T>(schema: ZodType<T>, value: unknown): T {
  // 例外を投げない safeParse で検証する
  const result = schema.safeParse(value);
  // 失敗なら 422 に詳細を添える
  if (!result.success) {
    throw new ApiError(UNPROCESSABLE, API_MESSAGES.validation, toIssues(result.error));
  }
  // 検証済みの値
  return result.data;
}

/**
 * JSON 本文を読み、Zod スキーマで検証して返す。
 * 415 (Content-Type 違い) → 413 (サイズ超過) → 400 (JSON 構文) → 422 (スキーマ) の順に落とす
 */
export async function readJsonBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  // Content-Type が application/json であること (パラメータ付き "application/json; charset=utf-8" も許す)
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.split(';')[0].trim().toLowerCase() !== JSON_MEDIA_TYPE) {
    throw new ApiError(UNSUPPORTED_MEDIA_TYPE, API_MESSAGES.unsupportedMediaType);
  }
  // 申告サイズが上限を超えていれば読む前に落とす
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > JSON_BODY_MAX_BYTES) {
    throw new ApiError(PAYLOAD_TOO_LARGE, API_MESSAGES.payloadTooLarge);
  }
  // 本文を文字列で読む
  const text = await request.text();
  // 実際のサイズも上限で落とす (申告が無い・嘘のときのため)
  if (Buffer.byteLength(text, 'utf8') > JSON_BODY_MAX_BYTES) {
    throw new ApiError(PAYLOAD_TOO_LARGE, API_MESSAGES.payloadTooLarge);
  }
  // JSON として解釈する (壊れていれば 400)
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(BAD_REQUEST, API_MESSAGES.invalidJson);
  }
  // スキーマで検証する (失敗は 422)
  return validateWith(schema, parsed);
}
