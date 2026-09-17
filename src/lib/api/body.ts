// リクエスト本文の読み取りと検証 (Content-Type・サイズ上限・JSON 構文・Zod スキーマ)
import type { ZodType } from 'zod';
import { API_MESSAGES, JSON_BODY_MAX_BYTES } from '@/lib/constants';
import { ApiError, type ApiIssue } from './errors';
import { HTTP_STATUS } from './http-status';

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
    throw new ApiError(
      HTTP_STATUS.UNPROCESSABLE_ENTITY,
      API_MESSAGES.validation,
      toIssues(result.error),
    );
  }
  // 検証済みの値
  return result.data;
}

/**
 * 本文を上限バイトまでで読む。request.text() は全量をメモリへ載せてからしか大きさが分からないため、
 * Content-Length を偽る・省く (chunked) 要求に対して上限が効かない。ストリームを読みながら数え、
 * 超えた時点で読むのをやめて 413 にする
 */
export async function readBodyWithinByteLimit(request: Request, maxBytes: number): Promise<string> {
  // 本文が無ければ空文字
  if (!request.body) return '';
  // ストリームを少しずつ読む
  const reader = request.body.getReader();
  // 読んだかたまりと合計バイト数
  const chunks: Uint8Array[] = [];
  let total = 0;
  // 上限を超えたら残りを読まずに打ち切る
  try {
    // 終端まで読む
    for (;;) {
      // 次のかたまり
      const { done, value } = await reader.read();
      if (done) break;
      // 合計を更新し、上限超過なら残りを受け取らずに打ち切って 413 (§8 供給元も止める)
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ApiError(HTTP_STATUS.PAYLOAD_TOO_LARGE, API_MESSAGES.payloadTooLarge);
      }
      chunks.push(value);
    }
  } finally {
    // 打ち切り・完了のどちらでもストリームを解放する (§8 リソースを確実に解放する)
    reader.releaseLock();
  }
  // UTF-8 として連結する
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * JSON 本文を読み、Zod スキーマで検証して返す。
 * 415 (Content-Type 違い) → 413 (サイズ超過) → 400 (JSON 構文) → 422 (スキーマ) の順に落とす
 */
export async function readJsonBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  // Content-Type が application/json であること (パラメータ付き "application/json; charset=utf-8" も許す)
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.split(';')[0].trim().toLowerCase() !== JSON_MEDIA_TYPE) {
    throw new ApiError(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE, API_MESSAGES.unsupportedMediaType);
  }
  // 申告サイズが上限を超えていれば読む前に落とす (正直な申告への早期拒否。実測は下で必ず行う)
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > JSON_BODY_MAX_BYTES) {
    throw new ApiError(HTTP_STATUS.PAYLOAD_TOO_LARGE, API_MESSAGES.payloadTooLarge);
  }
  // 本文を上限バイトまでで読む (申告が無い・嘘でも超えた時点で 413)
  const text = await readBodyWithinByteLimit(request, JSON_BODY_MAX_BYTES);
  // JSON として解釈する (壊れていれば 400)
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, API_MESSAGES.invalidJson);
  }
  // スキーマで検証する (失敗は 422)
  return validateWith(schema, parsed);
}
