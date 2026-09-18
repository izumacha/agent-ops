// リクエスト本文の読み取りと検証 (Content-Type・サイズ上限・JSON 構文・Zod スキーマ)
import type { ZodType } from 'zod';
import { API_MESSAGES, JSON_BODY_MAX_BYTES } from '@/lib/constants';
import { ApiError, validationError, type ApiIssue } from './errors';
import { HTTP_STATUS } from './http-status';

// 受け付けるメディア型
const JSON_MEDIA_TYPE = 'application/json';

// クライアントの切断でストリームが失敗したときのエラー種別 (Node / undici が使う code と name)
const DISCONNECT_CODES = new Set([
  'ECONNRESET',
  'ERR_STREAM_PREMATURE_CLOSE',
  'UND_ERR_ABORTED',
  'ABORT_ERR',
]);

// 切断由来のエラーか。code は cause 側に入ることがある (undici の TypeError: terminated など) ので 1 段たどる
function isConnectionReset(error: unknown): boolean {
  // 値から code / name を取り出す小さなヘルパー
  const describe = (value: unknown): { code?: unknown; name?: unknown; cause?: unknown } =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  // 本体と cause の両方を見る
  for (const candidate of [describe(error), describe(describe(error).cause)]) {
    // code が既知の切断コードなら切断
    if (typeof candidate.code === 'string' && DISCONNECT_CODES.has(candidate.code)) return true;
    // AbortError は名前でしか分からないことがある
    if (candidate.name === 'AbortError') return true;
  }
  // どちらでもなければ切断ではない
  return false;
}

// Zod の検証失敗を OpenAPI の issues 形式へ写す
function toIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): ApiIssue[] {
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
  if (!result.success) throw validationError(toIssues(result.error));
  // 検証済みの値
  return result.data;
}

/**
 * 本文を上限バイトまでで読む。request.text() は全量をメモリへ載せてからしか大きさが分からないため、
 * Content-Length を偽る・省く (chunked) 要求に対して上限が効かない。ストリームを読みながら数え、
 * 超えた時点で読むのをやめて 413 にする
 */
async function readBodyWithinByteLimit(request: Request, maxBytes: number): Promise<string> {
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
      // 終端なら抜ける
      if (done) break;
      // 合計を更新し、上限超過なら残りを読まずに 413。reader.cancel() は呼ばない —
      // Next.js の本文ストリームは cancel を受けると下層の IncomingMessage ごと破棄し、送信済みの 413 が届く前に
      // 接続が切れる (クライアントには ECONNRESET に見える)。読むのをやめて応答を返せば、残りは Node が捨てる
      total += value.byteLength;
      if (total > maxBytes) {
        throw new ApiError(HTTP_STATUS.PAYLOAD_TOO_LARGE, API_MESSAGES.payloadTooLarge);
      }
      // 上限内なら取っておく
      chunks.push(value);
    }
  } catch (error) {
    // 上限超過 (ApiError) はそのまま
    if (error instanceof ApiError) throw error;
    // 送信の途中でクライアントが切断すると read() が Node の切断エラーで reject する。サーバの障害ではないので
    // 500 と障害ログ (handler.ts の console.error) にせず 400 で終える (日常の切断で本物の内部エラーが埋もれない)
    if (request.signal.aborted || isConnectionReset(error)) {
      throw new ApiError(HTTP_STATUS.BAD_REQUEST, API_MESSAGES.bodyIncomplete);
    }
    // それ以外の失敗は内部エラーとして上へ
    throw error;
  } finally {
    // 打ち切り・完了のどちらでもストリームを解放する (§8 リソースを確実に解放する)
    reader.releaseLock();
  }
  // UTF-8 として連結する。不正なバイト列は置換 (U+FFFD) せず失敗させる (JSON は UTF-8 必須 (RFC 8259 §8.1)。
  // 黙って置換すると、送り主の意図と違う名前が保存されて一意判定もその文字列で行われる)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, API_MESSAGES.invalidJson);
  }
}

/**
 * JSON 本文を読み、Zod スキーマで検証して返す。
 * 415 (Content-Type 違い) → 413 (サイズ超過) → 400 (JSON 構文) → 422 (スキーマ) の順に落とす
 */
export async function readJsonBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  // 本文の上限は 1 か所で読み、申告サイズの事前拒否と実測の両方が同じ値を使う
  // (片方だけ定数を直に読むと、ルート別の枠を入れたとき「正直に申告した本文だけ 413」という向きの逆転が起きる)
  const maxBytes = JSON_BODY_MAX_BYTES;
  // Content-Type が application/json であること (パラメータ付き "application/json; charset=utf-8" も許す)
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.split(';')[0].trim().toLowerCase() !== JSON_MEDIA_TYPE) {
    throw new ApiError(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE, API_MESSAGES.unsupportedMediaType);
  }
  // 申告サイズが上限を超えていれば読む前に落とす (正直な申告への早期拒否。実測は下で必ず行う)。
  // **本番で「早く」落ちるわけではない** — 入口に proxy を置いているので Next.js は本文を読み切って
  // からハンドラを呼ぶ。ここで短絡するのはハンドラを直接呼ぶテスト経路だけで、送信中に打ち切るのは
  // 前段のリバースプロキシの責務 (ADR-0005 の宿題)
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiError(HTTP_STATUS.PAYLOAD_TOO_LARGE, API_MESSAGES.payloadTooLarge);
  }
  // 本文を上限バイトまでで読む (申告が無い・嘘でも超えた時点で 413)
  const text = await readBodyWithinByteLimit(request, maxBytes);
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
