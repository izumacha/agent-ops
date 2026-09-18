// 一覧のクエリ文字列 (limit / cursor) を PageQuery へ検証・正規化する
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
    .max(PAGE_CURSOR_MAX_LENGTH)
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
export function pickQuery(url: URL, keys: readonly string[]): Record<string, string | undefined> {
  // キーごとに値を取り出す
  return Object.fromEntries(keys.map((key) => [key, url.searchParams.get(key) ?? undefined]));
}

// pageQuerySchema が読むクエリのキー
export const PAGE_QUERY_KEYS = ['limit', 'cursor'] as const;

// URL のクエリから PageQuery を作る (不正値は 422)
export function parsePageQuery(url: URL): PageQuery {
  // 検証して返す
  return validateWith(pageQuerySchema, pickQuery(url, PAGE_QUERY_KEYS));
}
