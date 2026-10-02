// /api/v1/audit-logs: 監査ログの一覧 (view)。**追記専用なので更新・削除の操作は無い**
// (Port にメソッドが無く、DB のトリガが UPDATE / DELETE を拒否する)
import { requireAction } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import { pageQuerySchema, parseQuery } from '@/lib/api/pagination';
import { toAuditLogDto, toListDto } from '@/lib/api/serializers';
import type { ApiSchemas } from '@/lib/api-types';

// GET /audit-logs (listAuditLogs)
export const GET = route(async ({ request, principal, repos }) => {
  // view 権限 (誰が何をしたかは 3 役割すべてが見られる)
  const { tenantId } = requireAction(principal, 'view');
  // limit / cursor を検証する
  const pageQuery = parseQuery(new URL(request.url), pageQuerySchema);
  // 自テナントで絞って一覧する
  const page = await repos.auditLogs.list(tenantId, pageQuery);
  // DTO へ写す (hash / prevHash は載せない。理由は serializers.ts)
  const body: ApiSchemas['AuditLogList'] = toListDto(page, toAuditLogDto);
  return Response.json(body);
});
