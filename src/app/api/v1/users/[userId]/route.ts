// /api/v1/users/{userId}: ユーザーの無効化 (admin ロール限定)。削除ではなく無効化なのは docs/spec.md §3 の削除の規則
import { conflictError, notFoundError } from '@/lib/api/errors';
import { requireAdminRole } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import { toUserDto } from '@/lib/api/serializers';
import { API_MESSAGES } from '@/lib/constants';
import { Role } from '@/domain/types';

// 認証に依存するので静的化しない
export const dynamic = 'force-dynamic';

// DELETE /users/{userId} (disableUser)
export const DELETE = route<{ userId: string }>(async ({ params, principal, repos }) => {
  // admin ロールであること
  const { user: actor, tenantId } = requireAdminRole(principal);
  // 自分自身は無効化できない (テナントから締め出されるのを防ぐ)
  if (params.userId === actor.id) throw conflictError(API_MESSAGES.selfDisable);
  // 対象 (自テナント内。他テナントは 404)
  const target = await repos.users.findById(tenantId, params.userId);
  if (!target) throw notFoundError();
  // 最後の有効な admin は無効化できない (誰も管理できなくなる)
  if (target.role === Role.admin && target.disabledAt === null) {
    // 有効な admin の人数
    const admins = await repos.users.countActiveAdmins(tenantId);
    if (admins <= 1) throw conflictError(API_MESSAGES.lastAdmin);
  }
  // 無効化する (既に無効なら日時はそのまま)
  const disabled = await repos.users.disable(tenantId, params.userId);
  if (!disabled) throw notFoundError();
  // 無効化後のユーザーを返す
  return Response.json(toUserDto(disabled));
});
