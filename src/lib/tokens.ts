// Bearer トークン (ユーザートークン・API キー) の生成・ハッシュ・比較。
// 平文は発行応答でのみ返し、DB には SHA-256 ハッシュだけを保存する (docs/spec.md §5)
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// ユーザートークンの接頭辞 (種類を一目で判別し、誤ってログへ貼られたときに検索できるようにする)
export const USER_TOKEN_PREFIX = 'aop_u_';
// API キーの接頭辞
export const API_KEY_PREFIX = 'aop_k_';
// 乱数部分の長さ (バイト)。256 ビットあれば総当たりは現実的でない
const SECRET_RANDOM_BYTES = 32;
// 一覧表示用に残す先頭の文字数 (接頭辞を除く)。特定には十分で、推測には足りない長さ
const DISPLAY_PREFIX_CHARS = 6;

// 1 日のミリ秒 (有効期限の計算)
const DAY_MS = 24 * 60 * 60 * 1000;

// トークンの種類
export type SecretKind = 'user' | 'apiKey';

// 「今から days 日後」の有効期限を作る (テナント作成・トークン発行・CLI が同じ計算を使う。§6 DRY)
export function userTokenExpiresAt(days: number, now: Date = new Date()): Date {
  // 日数 × 1 日のミリ秒を足す
  return new Date(now.getTime() + days * DAY_MS);
}

// 種類ごとの接頭辞
const PREFIX_BY_KIND: Readonly<Record<SecretKind, string>> = {
  user: USER_TOKEN_PREFIX,
  apiKey: API_KEY_PREFIX,
};

// 新しい平文トークンを生成する (接頭辞 + base64url の乱数)
export function generateSecret(kind: SecretKind): string {
  // 暗号学的乱数を base64url で文字列化する (URL やヘッダで扱いやすい文字だけ)
  const random = randomBytes(SECRET_RANDOM_BYTES).toString('base64url');
  // 種類の接頭辞を付ける
  return `${PREFIX_BY_KIND[kind]}${random}`;
}

// 平文トークンの SHA-256 ハッシュ (16 進)。DB にはこれだけを保存する
export function hashSecret(secret: string): string {
  // SHA-256 で不可逆にする (トークンは高エントロピーなのでソルト無しでよい)
  return createHash('sha256').update(secret).digest('hex');
}

// 一覧表示用の先頭部分 (接頭辞 + 数文字)。秘密ではない
export function displayPrefix(secret: string): string {
  // 接頭辞 (aop_u_ / aop_k_) を含めた先頭を切り出す
  const kindPrefix = secret.startsWith(USER_TOKEN_PREFIX) ? USER_TOKEN_PREFIX : API_KEY_PREFIX;
  // 接頭辞 + 表示用の数文字
  return secret.slice(0, kindPrefix.length + DISPLAY_PREFIX_CHARS);
}

// 平文がユーザートークンの形か (認証時にどの照合経路へ回すかの振り分け)
export function isUserToken(secret: string): boolean {
  // 接頭辞で判定する
  return secret.startsWith(USER_TOKEN_PREFIX);
}

// 2 つの秘密文字列を定数時間で比較する (長さの違いを漏らさないよう、ハッシュしてから比べる)
export function secretsEqual(a: string, b: string): boolean {
  // 両方をハッシュ化して同じ長さのバイト列にする
  const left = Buffer.from(hashSecret(a), 'hex');
  const right = Buffer.from(hashSecret(b), 'hex');
  // 定数時間比較 (早期終了で一致長を漏らさない)
  return timingSafeEqual(left, right);
}
