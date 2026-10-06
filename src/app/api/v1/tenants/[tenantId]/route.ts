// /api/v1/tenants/{tenantId}: 自テナントの取得 (view 権限) と、プランの変更
// (プラットフォーム管理者専用。Step6)。他テナントの id は GET では 404 で隠す
import { readJsonBody } from '@/lib/api/body';
import { notFoundError } from '@/lib/api/errors';
import { requireAction, requirePlatformAdmin } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import { toTenantDto } from '@/lib/api/serializers';
import { assertAuditConfigured } from '@/lib/audit/record';
import { applyPlanChange, PLAN_CHANGE_SOURCE } from '@/lib/billing/apply-plan';
import { tenantPlanUpdateSchema } from '@/lib/validations/tenant';

// GET /tenants/{tenantId} (getTenant)
export const GET = route<{ tenantId: string }>(async ({ params, principal, repos }) => {
  // view 権限のテナントユーザーであること
  const { tenantId } = requireAction(principal, 'view');
  // 自分のテナント以外は存在を隠す
  if (params.tenantId !== tenantId) throw notFoundError();
  // テナントを引く (FK があるので通常は必ず居る)
  const tenant = await repos.tenants.findById(tenantId);
  if (!tenant) throw notFoundError();
  // DTO で返す
  return Response.json(toTenantDto(tenant));
});

/**
 * PATCH /tenants/{tenantId} (updateTenantPlan)
 *
 * **プラットフォーム管理者だけがプランを変えられる。** テナント内の admin には変えさせない —
 * 課金の実体は事業者側にあるので、アプリ側で勝手に上げられると請求と権限が食い違う
 * （上げる操作は事業者側の契約を通し、Webhook が反映する）。この経路は運用の手当て
 * （移行・障害時の暫定対応・事業者を介さない契約）のために残してある。
 *
 * **変更は監査ログに残す**（`tenant.plan_changed`）。プランは上限と機能の可否を決めるので、
 * 「いつ何が変わったか」が辿れないと後から 409 / 403 の原因を説明できない。
 */
export const PATCH = route<{ tenantId: string }>(async ({ request, params, principal, repos }) => {
  // プラットフォーム管理者だけ（テナント内の役割では呼べない）
  requirePlatformAdmin(principal);
  // 本文を検証する（415 → 413 → 400 → 422 の順）
  const input = await readJsonBody(request, tenantPlanUpdateSchema);
  // 対象のテナント（**変更前のプランを記録に残すので先に読む**）
  const current = await repos.tenants.findById(params.tenantId);
  if (!current) throw notFoundError();
  // **変える前に「監査ログを書ける状態か」を確かめる** — 変えてから記録に失敗すると、
  // 記録の無い変更が残り、しかも再試行は「既にそのプランだ」で永久に記録されない
  assertAuditConfigured();
  // 反映して記録する（反映と記録の形は Webhook と共有する）
  const applied = await applyPlanChange(repos, {
    tenantId: current.id,
    from: current.plan,
    update: { plan: input.plan },
    source: PLAN_CHANGE_SOURCE.platformAdmin,
  });
  // 読んだ直後に消えた場合（並行削除）は 404
  if (applied === null) throw notFoundError();
  // 変更後の行を返す
  return Response.json(toTenantDto({ ...current, plan: applied.plan }));
});
