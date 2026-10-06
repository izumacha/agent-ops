// テナント作成・プラン変更の入力スキーマ (OpenAPI の TenantCreate / TenantPlanUpdate と一致させる)
import { z } from './zod';
import { email, shortText } from './common';
import { Plan } from '@/domain/types';

// テナント名と最初の admin ユーザー
export const tenantCreateSchema = z.strictObject({
  name: shortText,
  adminEmail: email,
  adminName: shortText,
});

/**
 * プラン変更の本文（プラットフォーム管理者専用）。
 *
 * **プランだけを受ける。** 課金事業者側の id（`billingCustomerId` 等）は受け取らない —
 * 契約の実体は事業者側にあるので、アプリから書き換えられると請求と権限が食い違う
 * （連携は Webhook が作る）。**テナント名の変更もここでは扱わない**（別の操作）。
 */
export const tenantPlanUpdateSchema = z.strictObject({
  // 変更後のプラン（正準は src/domain/types.ts。enum 外の値は 422）
  plan: z.enum(Object.values(Plan)),
});
