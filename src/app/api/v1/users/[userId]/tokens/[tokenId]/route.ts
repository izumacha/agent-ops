// /api/v1/users/{userId}/tokens/{tokenId}: ログイントークンの失効 (admin ロール限定)
import { notFoundError } from '@/lib/api/errors';
import { requireAdminRole } from '@/lib/api/guard';
import { noContent, route } from '@/lib/api/handler';

// DELETE /users/{userId}/tokens/{tokenId} (revokeUserToken)
export const DELETE = route<{ userId: string; tokenId: string }>(
  async ({ params, principal, repos }) => {
    // admin ロールであること
    const { tenantId } = requireAdminRole(principal);
    // 失効させる (自テナント・対象ユーザーのトークンでなければ 404)
    const revoked = await repos.userTokens.revoke(tenantId, params.userId, params.tokenId);
    if (!revoked) throw notFoundError();
    // 本文無し
    return noContent();
  },
);
