// /api/v1/incidents: ガードレールの発火記録の一覧 (view)。UC-08 / UC-09
import { requireAction } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import { parseQuery } from '@/lib/api/pagination';
import { toIncidentDto, toListDto } from '@/lib/api/serializers';
import type { ApiSchemas } from '@/lib/api-types';
import { incidentListQuerySchema } from '@/lib/validations/guardrail';

// GET /incidents (listIncidents)
export const GET = route(async ({ request, principal, repos }) => {
  // view 権限
  const { tenantId } = requireAction(principal, 'view');
  // クエリをまとめて検証する (複数の誤りを 1 応答の issues で返す)
  const { agentId, status, ...pageQuery } = parseQuery(
    new URL(request.url),
    incidentListQuerySchema,
  );
  // 自テナントで絞って一覧する (絞り込みは指定があるときだけ効く)
  const page = await repos.incidents.list(tenantId, pageQuery, { agentId, status });
  // DTO へ写す
  const body: ApiSchemas['IncidentList'] = toListDto(page, toIncidentDto);
  return Response.json(body);
});
