// /api/v1/users/{userId}/role: 役割変更 (admin ロール限定。UC-02)
import { readJsonBody } from '@/lib/api/body';
import { conflictError, notFoundError } from '@/lib/api/errors';
import { requireAdminRole } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import { toUserDto } from '@/lib/api/serializers';
import { API_MESSAGES } from '@/lib/constants';
import { Role } from '@/domain/types';
import { userRoleSchema } from '@/lib/validations/user';

// 認証に依存するので静的化しない
export const dynamic = 'force-dynamic';

// PUT /users/{userId}/role (updateUserRole)
export const PUT = route<{ userId: string }>(async ({ request, params, principal, repos }) => {
  // admin ロールであること
  const { tenantId } = requireAdminRole(principal);
  // 本文を検証する
  const input = await readJsonBody(request, userRoleSchema);
  // 対象 (自テナント内。他テナントは 404)
  const target = await repos.users.findById(tenantId, params.userId);
  if (!target) throw notFoundError();
  // 最後の有効な admin を降格させない (誰も管理できなくなる)
  if (target.role === Role.admin && target.disabledAt === null && input.role !== Role.admin) {
    // 有効な admin の人数
    const admins = await repos.users.countActiveAdmins(tenantId);
    if (admins <= 1) throw conflictError(API_MESSAGES.lastAdmin);
  }
  // 役割を更新する
  const updated = await repos.users.updateRole(tenantId, params.userId, input.role);
  if (!updated) throw notFoundError();
  // 更新後のユーザーを返す
  return Response.json(toUserDto(updated));
});
