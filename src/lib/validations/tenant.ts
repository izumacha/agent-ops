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
 * **顧客 ID の連携もここで行う。** 受信 Webhook は `billingCustomerId` で**テナントを引く**だけで
 * 書かないので、連携を作る経路がどこにも無いと**事業者からのイベントが永久に反映されない**
 * （実際そうなっていた）。アプリから契約そのものを作れるわけではなく、**事業者の画面で作った
 * 顧客を運用者が結び付ける**ための項目で、同じ経路がすでにプランを直接変えられる
 * （＝これより強い操作）ので権限は増えない。**テナント内の利用者には触らせない**
 * （課金の実体は事業者側にあるため）。**テナント名の変更はここでは扱わない**（別の操作）。
 *
 * `null` を渡すと連携を外す（`undefined` = 項目を省略したときは据え置き。Port の約束と同じ）。
 */
export const tenantPlanUpdateSchema = z.strictObject({
  // 変更後のプラン（正準は src/domain/types.ts。enum 外の値は 422）
  plan: z.enum(Object.values(Plan)),
  // 事業者側の顧客 ID（`cus_...`）。省略で据え置き、null で連携を外す
  billingCustomerId: shortText.nullable().optional(),
  // 事業者側のサブスクリプション ID（`sub_...`）。同上。
  //
  // **修復の経路が無いと解約が永久に落ちる。** この列は Webhook だけが書くので、顧客を
  // 付け替えた（新しい契約が既に `active` で `created` / `updated` が届かない）ときに古い値が
  // 残る。すると `isStaleCancellation` が「いまの契約とは別の解約」と判断して**その後の解約を
  // すべて捨て**、受信は記録済みなので再送も来ない（＝解約済みのテナントが有料の権限を保つ）。
  billingSubscriptionId: shortText.nullable().optional(),
});
