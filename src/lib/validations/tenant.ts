// テナント作成の入力スキーマ (OpenAPI の TenantCreate と一致させる)
import { z } from './zod';
import { email, shortText } from './common';

// テナント名と最初の admin ユーザー
export const tenantCreateSchema = z.object({
  name: shortText,
  adminEmail: email,
  adminName: shortText,
});
