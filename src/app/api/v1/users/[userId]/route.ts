// /api/v1/users/{userId}: ユーザーの無効化 (admin ロール限定)。削除ではなく無効化なのは docs/spec.md §3 の削除の規則
import { conflictError, notFoundError } from '@/lib/api/errors';
import { requireAdminRole } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import { toUserDto } from '@/lib/api/serializers';
import { API_MESSAGES } from '@/lib/constants';

// DELETE /users/{userId} (disableUser)
export const DELETE = route<{ userId: string }>(async ({ params, principal, repos }) => {
  // admin ロールであること
  const { user: actor, tenantId } = requireAdminRole(principal);
  // 自分自身は無効化できない (テナントから締め出されるのを防ぐ)
  if (params.userId === actor.id) throw conflictError(API_MESSAGES.selfDisable);
  // 無効化する (他テナントは not_found、最後の有効な admin は last_admin。判定と更新はデータ層が原子的に行う)
  const result = await repos.users.disable(tenantId, params.userId);
  if (result.status === 'not_found') throw notFoundError();
  if (result.status === 'last_admin') throw conflictError(API_MESSAGES.lastAdmin);
  // 無効化は冪等なのでここへは来ない (型の網羅性のため残す)
  if (result.status === 'disabled') throw conflictError(API_MESSAGES.userDisabled);
  // 無効化後のユーザーを返す
  return Response.json(toUserDto(result.user));
});
