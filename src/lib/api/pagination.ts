// 一覧のクエリ文字列 (limit / cursor) を PageQuery へ検証・正規化する
import type { ZodObject, ZodType, ZodTypeAny } from 'zod';
import { z } from '@/lib/validations/zod';
import type { PageQuery } from '@/data';
import { decodeCursor } from '@/data/page';
import { parseDecimalInteger } from '@/domain/decimal-integer';
import {
  API_MESSAGES,
  PAGE_CURSOR_MAX_LENGTH,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
} from '@/lib/constants';
import { validateWith } from './body';

// 10 進の整数だけを受ける文字列 (判定は domain/decimal-integer が唯一の定義。CLI の --days と共有する)
const decimalInteger = z.string().transform((value, ctx) => {
  // 純粋関数で変換する
  const parsed = parseDecimalInteger(value);
  // 形が違えば検証エラーにする
  if (parsed === null) {
    ctx.addIssue({ code: 'custom', message: API_MESSAGES.invalidLimit });
    return z.NEVER;
  }
  // 数値を返す
  return parsed;
});

// limit は 1〜最大値の整数 (省略時は既定値)、cursor は前応答の nextCursor (符号化されたキーセット。形が違えば 422)
export const pageQuerySchema = z.object({
  limit: decimalInteger
    .pipe(z.number().int().min(1).max(PAGE_LIMIT_MAX))
    .default(PAGE_LIMIT_DEFAULT),
  cursor: z
    .string()
    // 長さ超過も「形が違う」の一種なので同じ文言にする (上限は復号前の DoS 対策として残す)
    .max(PAGE_CURSOR_MAX_LENGTH, { message: API_MESSAGES.invalidCursor })
    .transform((value, ctx) => {
      // 位置へ復号する (ここで 1 回だけ。アダプタには復号済みの位置が届く)
      const key = decodeCursor(value);
      // 形が違えば検証エラー
      if (key === null) {
        ctx.addIssue({ code: 'custom', message: API_MESSAGES.invalidCursor });
        return z.NEVER;
      }
      return key;
    })
    .optional(),
});

// URL のクエリから指定したキーを取り出す (無いキーは undefined のまま渡して default / optional に任せる)
function pickQuery(url: URL, keys: readonly string[]): Record<string, string | undefined> {
  // キーごとに値を取り出す
  return Object.fromEntries(keys.map((key) => [key, url.searchParams.get(key) ?? undefined]));
}

/**
 * URL のクエリをスキーマで検証して返す (不正値は 422)。読むキーはスキーマの shape から導くので、
 * 「キーの一覧とスキーマが食い違って指定が黙って無視される」形を書けない (手で並べるとその事故が起きる)
 */
export function parseQuery<T>(
  url: URL,
  schema: ZodObject<Record<string, ZodTypeAny>> & ZodType<T>,
): T {
  // shape のキーがそのままクエリ名
  const keys = Object.keys(schema.shape);
  // 値を取り出して検証する
  return validateWith(schema, pickQuery(url, keys));
}

// URL のクエリから PageQuery を作る (一覧の共通形)
export function parsePageQuery(url: URL): PageQuery {
  // 共通のページ指定スキーマで検証する
  return parseQuery(url, pageQuerySchema);
}
