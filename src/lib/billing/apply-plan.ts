// 契約プランの変更を「反映して監査ログに残す」1 か所（Step6）。
//
// **経路は 2 つある**（課金事業者の Webhook と、プラットフォーム管理者の
// `PATCH /tenants/{tenantId}`）が、**残す記録は 1 つの形にそろえる** — 別々に書くと
// 「Webhook の変更だけ記録が無い」「payload の項目名が違う」といった食い違いが静かに生まれ、
// 監査ログを読む側が 2 つの操作として数えることになる（`AuditAction` の冒頭のコメントと同じ理由）。
import type { Repositories } from '@/data';
import { AuditAction, AuditTargetType } from '@/domain/audit/action';
import type { Plan } from '@/domain/types';
import { recordAudit } from '@/lib/audit/record';
import type { UpdateTenantPlanInput } from '@/data/ports';

/**
 * プランを変えた経路（監査ログの payload に残す）。
 *
 * **「誰が」だけでは足りない** — Webhook 由来の変更は `actorId` が null になるので、
 * 「プラットフォーム管理者が入れた null」と区別が付かない（プラットフォーム管理者は
 * テナント内のユーザーではないので、こちらも `actorId` を持たない）。
 */
export const PLAN_CHANGE_SOURCE = {
  // 課金事業者からの受信 Webhook
  webhook: 'billing_webhook',
  // プラットフォーム管理者の操作
  platformAdmin: 'platform_admin',
} as const;
/** プランを変えた経路の型 */
export type PlanChangeSource = (typeof PLAN_CHANGE_SOURCE)[keyof typeof PLAN_CHANGE_SOURCE];

/** プラン変更の入力（`updatePlan` へ渡すものと、記録に要るもの） */
export interface ApplyPlanChangeInput {
  // 対象のテナント
  tenantId: string;
  // 変更前のプラン（記録に残すために呼び出し側が渡す）
  from: Plan;
  // 変更後のプランと課金事業者側の id
  update: UpdateTenantPlanInput;
  // どの経路からの変更か
  source: PlanChangeSource;
}

/**
 * プランを反映して監査ログに 1 行残す。対象が無ければ `null`（呼び出し側が 404 にする）。
 *
 * **呼び出し側は先に `assertAuditConfigured()` を通すこと。** 反映してから記録に失敗すると
 * 記録の無い変更が残り、しかも再試行は「既にそのプランだ」で永久に記録されない
 * （`src/lib/audit/record.ts` が書いている「人が行う操作」と同じ扱い）。
 */
export async function applyPlanChange(
  repos: Repositories,
  input: ApplyPlanChangeInput,
): Promise<{ plan: Plan } | null> {
  // プランと課金事業者側の id を同時に書く
  const updated = await repos.tenants.updatePlan(input.tenantId, input.update);
  // 対象が無ければ何も記録しない
  if (updated === null) return null;
  // 監査ログに残す（payload は**平坦な辞書**でキーは辞書順。入れ子は許されない）
  await recordAudit(repos, {
    tenantId: input.tenantId,
    // 人の操作でもテナント内のユーザーではないので actorId は持たない
    actorId: null,
    action: AuditAction.tenant_plan_changed,
    targetType: AuditTargetType.tenant,
    targetId: input.tenantId,
    payload: { from: input.from, source: input.source, to: updated.plan },
  });
  // 反映後のプラン
  return { plan: updated.plan };
}
