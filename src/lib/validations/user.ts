// ユーザー招待・役割変更の入力スキーマ (OpenAPI の UserCreate / updateUserRole と一致させる)
import { z } from 'zod';
import { email, role, shortText } from './common';

// 招待
export const userCreateSchema = z.object({
  email,
  name: shortText,
  role,
});
// 検証後の型
export type UserCreateInput = z.infer<typeof userCreateSchema>;

// 役割変更
export const userRoleSchema = z.object({ role });
// 検証後の型
export type UserRoleInput = z.infer<typeof userRoleSchema>;
