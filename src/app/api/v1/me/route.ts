// /api/v1/me: 認証中のユーザーと所属テナント (トークンの動作確認・クライアントの初期化に使う)
import { notFoundError } from '@/lib/api/errors';
import { requireTenantUser } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import { toTenantDto, toUserDto } from '@/lib/api/serializers';
import type { ApiSchemas } from '@/lib/api-types';

// GET /me (getMe)
export const GET = route(async ({ principal, repos }) => {
  // テナントのユーザーであること (プラットフォーム管理者には「自分」が無い)
  const { user, tenantId } = requireTenantUser(principal);
  // 所属テナント
  const tenant = await repos.tenants.findById(tenantId);
  if (!tenant) throw notFoundError();
  // DTO で返す
  const body: ApiSchemas['Me'] = { user: toUserDto(user), tenant: toTenantDto(tenant) };
  return Response.json(body);
});
