// /api/v1/users/{userId}/role: 役割変更 (admin ロール限定。UC-02)
import { readJsonBody } from '@/lib/api/body';
import { conflictError, notFoundError } from '@/lib/api/errors';
import { requireAdminRole } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import { toUserDto } from '@/lib/api/serializers';
import { API_MESSAGES } from '@/lib/constants';
import { userRoleSchema } from '@/lib/validations/user';

// PUT /users/{userId}/role (updateUserRole)
export const PUT = route<{ userId: string }>(async ({ request, params, principal, repos }) => {
  // admin ロールであること
  const { tenantId } = requireAdminRole(principal);
  // 本文を検証する
  const input = await readJsonBody(request, userRoleSchema);
  // 役割を更新する (他テナントは not_found、最後の有効な admin の降格は last_admin。判定と更新はデータ層が原子的に行う)
  const result = await repos.users.updateRole(tenantId, params.userId, input.role);
  if (result.status === 'not_found') throw notFoundError();
  if (result.status === 'last_admin') throw conflictError(API_MESSAGES.lastAdmin);
  // 無効化済みユーザーの役割は変えない (認証できない admin を作らない。トークン発行と同じ 409)
  if (result.status === 'disabled') throw conflictError(API_MESSAGES.userDisabled);
  // 更新後のユーザーを返す
  return Response.json(toUserDto(result.user));
});
