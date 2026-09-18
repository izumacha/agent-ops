// ユーザートークン発行の入力スキーマ (OpenAPI の UserTokenCreate と一致させる)
import { z } from './zod';
import { USER_TOKEN_DEFAULT_TTL_DAYS, USER_TOKEN_MAX_TTL_DAYS } from '@/lib/constants';
import { shortText } from './common';

// 用途名と有効期間 (日)。省略時は既定値、無期限は作れない
export const userTokenCreateSchema = z.object({
  name: shortText,
  expiresInDays: z
    .number()
    .int()
    .min(1)
    .max(USER_TOKEN_MAX_TTL_DAYS)
    .default(USER_TOKEN_DEFAULT_TTL_DAYS),
});
