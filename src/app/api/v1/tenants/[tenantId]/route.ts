// /api/v1/tenants/{tenantId}: 自テナントの取得 (view 権限。他テナントの id は 404 で隠す)
import { notFoundError } from '@/lib/api/errors';
import { requireAction } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import { toTenantDto } from '@/lib/api/serializers';

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
