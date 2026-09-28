// リクエスト本文の読み取りと検証 (Content-Type・サイズ上限・JSON 構文・Zod スキーマ)
import type { ZodType } from 'zod';
import { API_MESSAGES, JSON_BODY_MAX_BYTES, JSON_BODY_MAX_DEPTH } from '@/lib/constants';
import { readStreamWithinByteLimit } from '@/lib/stream-bytes';
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
 * 超えた時点で読むのをやめて 413 にする。
 * **数えながら読む処理そのものは src/lib/stream-bytes.ts と共有する** (上流の応答も同じ読み方が要る)。
 * ここが持つのは「その結果をどの HTTP エラーへ写すか」だけ
 */
async function readBodyWithinByteLimit(request: Request, maxBytes: number): Promise<string> {
  // 上限まで読む (読み取り自体の失敗は投げたまま上がってくる)
  let result;
  try {
    result = await readStreamWithinByteLimit(request.body, maxBytes);
  } catch (error) {
    // 送信の途中でクライアントが切断すると read() が Node の切断エラーで reject する。サーバの障害ではないので
    // 500 と障害ログ (handler.ts の console.error) にせず 400 で終える (日常の切断で本物の内部エラーが埋もれない)
    if (request.signal.aborted || isConnectionReset(error)) {
      throw new ApiError(HTTP_STATUS.BAD_REQUEST, API_MESSAGES.bodyIncomplete);
    }
    // それ以外の失敗は内部エラーとして上へ
    throw error;
  }
  // 上限内で読めた本文
  if (result.ok) return result.text;
  // 上限超過は 413
  if (result.reason === 'too_large') {
    throw new ApiError(HTTP_STATUS.PAYLOAD_TOO_LARGE, API_MESSAGES.payloadTooLarge);
  }
  // UTF-8 として壊れたバイト列は 400 (JSON は UTF-8 必須 (RFC 8259 §8.1)。黙って置換 (U+FFFD) すると、
  // 送り主の意図と違う名前が保存されて一意判定もその文字列で行われる)
  throw new ApiError(HTTP_STATUS.BAD_REQUEST, API_MESSAGES.invalidJson);
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
  // **入れ子の深さを縛る** (超過は 422)。サイズだけでは資源の消費を縛れない — 理由と値は
  // `src/lib/body-limits.ts` の `JSON_BODY_MAX_DEPTH`
  if (exceedsMaxDepth(parsed, JSON_BODY_MAX_DEPTH)) {
    throw new ApiError(HTTP_STATUS.UNPROCESSABLE_ENTITY, API_MESSAGES.bodyTooDeep);
  }
  // スキーマで検証する (失敗は 422)
  return validateWith(schema, parsed);
}

/**
 * 解釈した値の入れ子が上限を超えているか。
 * **再帰で書かない** — 上限で打ち切る再帰なら段数は `limit + 1` で頭打ちになるので
 * スタックは尽きないが、そうすると**判定の安全性が `limit` の値に依存する**ことになる
 * （上限を大きくする差分が、同時に判定そのものを壊しうる）。明示のスタックなら
 * 上限の値と無関係に成り立つ。上限を超えた時点で打ち切る (深い側から先に見るので早く止まる)。
 *
 * **入れ子になりうるものだけを積む。** 値の種類を見ずに積んでいた版は、結果は同じでも
 * 64 KiB の `[0,0,…]`（要素 32,768）で 0.64ms・一時ヒープ約 3.9 MiB を使い、同じ本文の
 * `JSON.parse`（0.55ms）より重かった。積む前にふるうと 0.015ms（41 倍速）になる。
 * オブジェクトの子は `Object.values` ではなく `Object.keys` で辿る — 値の配列を作らない分、
 * キーの多い本文（8,348 キー）で 2.01ms → 0.94ms になる（判定結果は全ケースで一致）
 * @param value JSON として解釈した値
 * @param limit 許す深さ
 * @returns 超えていれば true
 */
export function exceedsMaxDepth(value: unknown, limit: number): boolean {
  // 辿る対象と、その深さ (**積むのは入れ子になりうるものだけ**)
  const stack: { node: object; depth: number }[] = [];
  // 根がオブジェクトや配列でなければ、それ以上深くならない (積まずに終わる)
  if (value !== null && typeof value === 'object') stack.push({ node: value, depth: 1 });
  // 空になるまで辿る
  while (stack.length > 0) {
    // 次に見るもの
    const current = stack.pop();
    // 取り出せなければ終わり (型のため)
    if (current === undefined) break;
    // この時点で上限を超えていれば打ち切る
    if (current.depth > limit) return true;
    // 子はここより 1 段深い
    const depth = current.depth + 1;
    // 配列は要素をそのまま辿る
    if (Array.isArray(current.node)) {
      for (const child of current.node)
        // 入れ子になりうるものだけ積む
        if (child !== null && typeof child === 'object') stack.push({ node: child, depth });
    } else {
      // オブジェクトは自分のキーだけを辿る (値の配列を作らない)。
      // **`__proto__` も普通のキーとして辿る** — `JSON.parse` はこれを**自分のキー**として作る
      // ので（プロトタイプは差し替わらない）、汚染対策のつもりで読み飛ばすと、その形だけが
      // 上限をすり抜ける（`tests/body-depth.test.ts` が固定する）
      const record = current.node as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        // そのキーの値
        const child = record[key];
        // 入れ子になりうるものだけ積む
        if (child !== null && typeof child === 'object') stack.push({ node: child, depth });
      }
    }
  }
  // 上限以内
  return false;
}
