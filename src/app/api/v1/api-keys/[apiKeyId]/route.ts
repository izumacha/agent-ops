// /api/v1/api-keys/{apiKeyId}: API キーの失効 (stop 権限)。失効済みへの再実行も 204 (冪等)
import { notFoundError } from '@/lib/api/errors';
import { requireAction } from '@/lib/api/guard';
import { noContent, route } from '@/lib/api/handler';

// 認証に依存するので静的化しない
export const dynamic = 'force-dynamic';

// DELETE /api-keys/{apiKeyId} (revokeApiKey)
export const DELETE = route<{ apiKeyId: string }>(async ({ params, principal, repos }) => {
  // stop 権限
  const { tenantId } = requireAction(principal, 'stop');
  // 自テナント内で失効させる (他テナントは 404)
  const revoked = await repos.apiKeys.revoke(tenantId, params.apiKeyId);
  if (!revoked) throw notFoundError();
  // 本文無し
  return noContent();
});
