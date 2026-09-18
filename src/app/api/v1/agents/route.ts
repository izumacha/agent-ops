// /api/v1/agents: エージェント台帳の一覧 (view) と登録 (execute)。UC-03
import { readJsonBody } from '@/lib/api/body';
import { requireAction } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { pageQuerySchema, parseQuery } from '@/lib/api/pagination';
import { toListDto, toAgentDto } from '@/lib/api/serializers';
import type { ApiSchemas } from '@/lib/api-types';
import { agentCreateSchema } from '@/lib/validations/agent';
import { agentStatus } from '@/lib/validations/common';

// 一覧のクエリ (limit / cursor に status を足す)。1 つのスキーマで検証し、複数の誤りを 1 応答の issues で返す
const agentListQuerySchema = pageQuerySchema.extend({ status: agentStatus.optional() });
// GET /agents (listAgents)
export const GET = route(async ({ request, principal, repos }) => {
  // view 権限
  const { tenantId } = requireAction(principal, 'view');
  // クエリをまとめて検証する
  const { status, ...pageQuery } = parseQuery(new URL(request.url), agentListQuerySchema);
  // 自テナントで絞って一覧する
  const page = await repos.agents.list(tenantId, pageQuery, { status });
  // DTO へ写す
  const body: ApiSchemas['AgentList'] = toListDto(page, toAgentDto);
  return Response.json(body);
});

// POST /agents (createAgent)
export const POST = route(async ({ request, principal, repos }) => {
  // execute 権限
  const { tenantId } = requireAction(principal, 'execute');
  // 本文を検証する
  const input = await readJsonBody(request, agentCreateSchema);
  // 自テナントに登録する (名前重複は DuplicateError → 422)
  const agent = await repos.agents.create({
    tenantId,
    name: input.name,
    description: input.description ?? null,
    provider: input.provider,
    model: input.model,
    budgetMicroUsd: input.budgetMicroUsd ?? null,
  });
  // 201 で返す
  return Response.json(toAgentDto(agent), { status: HTTP_STATUS.CREATED });
});
