// 各スキーマで共有する部品 (長さ上限は OpenAPI 定義と一致させる)。
// 本文のスキーマは z.strictObject を使う — 未知キーを黙って剥がすと、契約の additionalProperties: false と食い違い、
// 「status を PATCH に入れたのに何も起きない」といった無言の無視が起きる (誤りは 422 で返す)
import { z } from './zod';
import { parseMicroUsd } from '@/domain/money';
import { isResourceId } from '@/domain/resource-id';
import {
  API_MESSAGES,
  EMAIL_MAX_LENGTH,
  LONG_TEXT_MAX_LENGTH,
  SHORT_TEXT_MAX_LENGTH,
} from '@/lib/constants';
import { normalizeEmail } from '@/domain/email';
import { AgentStatus, Provider, Role } from '@/domain/types';

// 制御文字 (C0 と DEL)。改行・タブ・復帰だけは複数行の説明文で意味を持つので、長い文字列でのみ許す。
// **弾く理由は「同じ値に化ける」こと** — 本番では Next / undici の本文パイプラインが NUL を黙って落とすため
// `ag<NUL>ent` と `agent` が同じ名前として保存され、一意判定も後者で行われる (実測)。一方テストが組み立てる
// Request では NUL が残るので、検証を書かないとテストと本番で「見ている本文」が違う。明示的に弾けば両方で同じ
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
// 対になっていないサロゲート (孤立サロゲート)。**制御文字と同じ「別の値に化ける」系統の入力**で、
// JSON のエスケープ (`\ud800`) なら本文は純 ASCII なので UTF-8 の復号も通り、長さ・文字種の検査にも
// 掛からないまま DB ドライバが UTF-8 へ符号化する時点で U+FFFD へ置換される。実測では
// `"X\ud800Y"` と `"X\ud801Y"` と `"X<U+FFFD>Y"` の 3 つが同じ行に畳まれ、一意判定もその化けた値で行われた
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// 改行・タブ・復帰を除いた制御文字
const CONTROL_CHARACTERS_EXCEPT_BREAKS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
// 見た目だけを偽る文字 (U+202E の右横書き指示・U+200B のゼロ幅空白など) は**意図的に許す** —
// 値としては別物なので保存も一意判定も取り違えず、Step1 は UI を持たない。表示のなりすましが
// 問題になるのは画面を作る Step5 なので、そこで表示側の正規化とあわせて決める

// 表示名など短い文字列 (1〜100 文字)。前後の空白を除いてから長さを見る (空白だけの名前や末尾空白違いの「同名」を作らない)
export const shortText = z
  .string()
  .trim()
  .min(1)
  .max(SHORT_TEXT_MAX_LENGTH)
  // 1 行の表示名なので改行・タブも含めて制御文字は一切許さない
  .refine((value) => !CONTROL_CHARACTERS.test(value), { message: API_MESSAGES.controlCharacters })
  // 保存時に U+FFFD へ化ける孤立サロゲートも許さない
  .refine((value) => !LONE_SURROGATE.test(value), { message: API_MESSAGES.loneSurrogate });

// 資源 id (本文に載る id。パスセグメントと同じ規則で見る。規則は @/domain/resource-id が唯一の定義)
export const resourceId = z
  .string()
  .trim()
  .refine(isResourceId, { message: API_MESSAGES.invalidResourceId });
// メールアドレス (RFC 5321 の上限 254 文字)。前後の空白を除いてから形を見て、小文字に正規化する
// (テナント内の一意性 (tenantId, email) と findByEmail が大文字小文字の違いで別人扱いしないため。正規化の規則は
// normalizeEmail が唯一の定義。z.email() は前後の空白を弾くので、先に trim しないと CLI (normalizeEmail で trim
// してから検索) と API で受理集合が食い違う)
export const email = z
  .string()
  .trim()
  .pipe(z.email().max(EMAIL_MAX_LENGTH))
  .transform(normalizeEmail);
// 役割 (正準の enum から導く)
export const role = z.enum(Object.values(Role));
// LLM プロバイダ
export const provider = z.enum(Object.values(Provider));
// エージェントの稼働状態
export const agentStatus = z.enum(Object.values(AgentStatus));
// マイクロ USD (文字列 → BigInt。桁数・形・範囲はすべて domain/money が判定し、文言は 1 か所から出す。
// ここに .max(19) を置くと 20 桁以上だけ Zod の汎用文言になり、同じ「範囲外」で文言が割れる)
export const microUsd = z.string().transform((value, ctx) => {
  // 純粋関数で変換する
  const parsed = parseMicroUsd(value);
  // 変換できなければ検証エラーにする
  if (parsed === null) {
    ctx.addIssue({ code: 'custom', message: API_MESSAGES.microUsdOutOfRange });
    return z.NEVER;
  }
  // BigInt を返す
  return parsed;
});
// 説明文 (1〜1000 文字)。前後の空白は除き、空白だけは弾く (未設定は null / 省略で表す。'' を通すと
// 「未設定」の表現が null と '' の 2 通りに割れる)
export const longText = z
  .string()
  .trim()
  .min(1)
  .max(LONG_TEXT_MAX_LENGTH)
  // 複数行の説明文なので改行・タブ・復帰は許し、それ以外の制御文字は弾く
  .refine((value) => !CONTROL_CHARACTERS_EXCEPT_BREAKS.test(value), {
    message: API_MESSAGES.controlCharacters,
  })
  // 保存時に U+FFFD へ化ける孤立サロゲートも許さない
  .refine((value) => !LONE_SURROGATE.test(value), { message: API_MESSAGES.loneSurrogate });
