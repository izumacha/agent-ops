// 一覧のクエリ文字列 (limit / cursor) を PageQuery へ検証・正規化する
import { z } from '@/lib/validations/zod';
import type { PageQuery } from '@/data';
import { decodeCursor } from '@/data/page';
import {
  API_MESSAGES,
  PAGE_CURSOR_MAX_LENGTH,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
} from '@/lib/constants';
import { validateWith } from './body';

// 10 進の整数だけを受ける文字列 (z.coerce.number() は Number() 変換なので 0x10 / 1e2 / +5 / 空白付きも通り、
// OpenAPI の type: integer より受理集合が広くなる。契約どおり 10 進の数字だけを通す。桁数は上限値より十分大きい 6 桁まで)
const decimalInteger = z
  .string()
  .regex(/^[0-9]{1,6}$/, { message: API_MESSAGES.invalidLimit })
  .transform(Number);

// limit は 1〜最大値の整数 (省略時は既定値)、cursor は前応答の nextCursor (符号化されたキーセット。形が違えば 422)
export const pageQuerySchema = z.object({
  limit: decimalInteger
    .pipe(z.number().int().min(1).max(PAGE_LIMIT_MAX))
    .default(PAGE_LIMIT_DEFAULT),
  cursor: z
    .string()
    .min(1)
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
