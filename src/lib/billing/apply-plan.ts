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
import type { TenantRecord, UpdateTenantPlanInput } from '@/data/ports';

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

/**
 * 課金連携（顧客 ID / サブスクリプション ID）をどう書いたか。
 *
 * **プランだけを記録に残すと、連携の変更が痕跡なしで通る** — 顧客 ID は「以後どのテナントの
 * プランを事業者のイベントが変えるか」を決めるので、付け替えは契約の付け替えそのもの。
 * ところが `from` と `to` は同じプランのままなので、payload が 2 つとも「何も変わっていない行」に
 * 見える（監査ログを読む側が「なぜ別のテナントがこの契約のイベントを受け取り始めたか」を
 * 再構成できない）。**値そのものは残さない**（事業者側の id を監査テーブルへ複製しない）。
 */
export const PLAN_CHANGE_LINK = {
  // 値を入れた（結び付けた・付け替えた）
  set: 'set',
  // null を渡して外した
  cleared: 'cleared',
  // 項目を省いたので据え置き
  unchanged: 'unchanged',
} as const;
/** 連携の書き方の型 */
export type PlanChangeLink = (typeof PLAN_CHANGE_LINK)[keyof typeof PLAN_CHANGE_LINK];

// 渡された値から「どう書いたか」を導く（呼び出し側に判断を写さない）
function linkOf(value: string | null | undefined): PlanChangeLink {
  // 項目を省いたなら据え置き
  if (value === undefined) return PLAN_CHANGE_LINK.unchanged;
  // null は連携を外す指示
  if (value === null) return PLAN_CHANGE_LINK.cleared;
  // それ以外は値を入れた
  return PLAN_CHANGE_LINK.set;
}

/** プラン変更の記録に要るもの（反映そのものは呼び出し側が済ませている） */
export interface PlanChangeAuditInput {
  // 対象のテナント
  tenantId: string;
  // 変更前のプラン（呼び出し側が反映前に読んで渡す）
  from: Plan;
  // 変更後のプラン（**反映後の行から取る**。渡した値ではなく実際に書かれた値）
  to: Plan;
  // 反映に使った入力（連携を「入れた / 外した / 据え置き」のどれだったかを導くため）
  update: UpdateTenantPlanInput;
  // どの経路からの変更か
  source: PlanChangeSource;
}

/**
 * プラン変更を監査ログに 1 行残す（反映そのものは呼び出し側が済ませている）。
 *
 * **記録だけを切り出してあるのは、反映の仕方が経路で違うため。** Webhook は「受信の記録」と
 * 同じ原子的操作の中で反映する（`billingEvents.recordOnce`）ので `updatePlan` を呼ばないが、
 * **残す記録は 1 つの形にそろえる**必要がある（このファイル冒頭の理由）。
 *
 * **呼び出し側は反映より前に `assertAuditConfigured()` を通すこと。** 反映してから記録に
 * 失敗すると記録の無い変更が残り、しかも再試行は「既にそのプランだ」で永久に記録されない
 * （`src/lib/audit/record.ts` が書いている「人が行う操作」と同じ扱い）。
 */
export async function recordPlanChangeAudit(
  repos: Repositories,
  input: PlanChangeAuditInput,
): Promise<void> {
  // 監査ログに残す（payload は**平坦な辞書**でキーは辞書順。入れ子は許されない）
  await recordAudit(repos, {
    tenantId: input.tenantId,
    // 人の操作でもテナント内のユーザーではないので actorId は持たない
    actorId: null,
    action: AuditAction.tenant_plan_changed,
    targetType: AuditTargetType.tenant,
    targetId: input.tenantId,
    // **連携の書き方も残す**（値ではなく「入れた / 外した / 据え置き」だけ。理由は上の表）
    payload: {
      customerLink: linkOf(input.update.billingCustomerId),
      from: input.from,
      source: input.source,
      subscriptionLink: linkOf(input.update.billingSubscriptionId),
      to: input.to,
    },
  });
}

/**
 * プラン変更の入力（`updatePlan` へ渡すものと、記録に要るもの）。
 *
 * **記録側の入力から `to` を除いたもの**として表す — こちらは反映も行うので、変更後のプランは
 * 呼び出し側が渡すのではなく**実際に書かれた行**から取る。2 つの interface に同じ項目を並べると、
 * 監査の payload に項目が増えたとき片方だけが直る（§6 DRY）。
 */
export type ApplyPlanChangeInput = Omit<PlanChangeAuditInput, 'to'>;

/**
 * プランを反映して監査ログに 1 行残す。対象が無ければ `null`（呼び出し側が 404 にする）。
 *
 * **返すのは反映後の行そのもの。** プランだけを返していた頃は、呼び出し側が「読んだ行＋プラン」で
 * 応答を組み立てていたので、`TenantDto` に可変の項目（`updatedAt` や課金連携）が増えた瞬間に
 * **更新前の値を返す**形になる（テストは 1 件も落ちない）。
 *
 * **呼び出し側は先に `assertAuditConfigured()` を通すこと**（理由は `recordPlanChangeAudit`）。
 */
export async function applyPlanChange(
  repos: Repositories,
  input: ApplyPlanChangeInput,
): Promise<TenantRecord | null> {
  // プランと課金事業者側の id を同時に書く
  const updated = await repos.tenants.updatePlan(input.tenantId, input.update);
  // 対象が無ければ何も記録しない
  if (updated === null) return null;
  // 記録の形は Webhook と共有する
  await recordPlanChangeAudit(repos, {
    tenantId: input.tenantId,
    from: input.from,
    to: updated.plan,
    update: input.update,
    source: input.source,
  });
  // 反映後の行
  return updated;
}
