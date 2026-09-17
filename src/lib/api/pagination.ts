// 一覧のクエリ文字列 (limit / cursor) を PageQuery へ検証・正規化する
import { z } from 'zod';
import type { PageQuery } from '@/data';
import { decodeCursor } from '@/data/page';
import {
  API_MESSAGES,
  PAGE_CURSOR_MAX_LENGTH,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
} from '@/lib/constants';
import { validateWith } from './body';

// limit は 1〜最大値の整数 (省略時は既定値)、cursor は前応答の nextCursor (符号化されたキーセット。形が違えば 422)
const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
  cursor: z
    .string()
    .min(1)
    .max(PAGE_CURSOR_MAX_LENGTH)
    .refine((value) => decodeCursor(value) !== null, { message: API_MESSAGES.invalidCursor })
    .optional(),
});

// URL のクエリから PageQuery を作る (不正値は 422)
export function parsePageQuery(url: URL): PageQuery {
  // クエリの値を取り出す (無いキーは undefined のまま渡して default / optional に任せる)
  const raw = {
    limit: url.searchParams.get('limit') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
  };
  // 検証して返す
  return validateWith(pageQuerySchema, raw);
}
