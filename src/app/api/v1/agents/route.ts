// /api/v1/agents: エージェント台帳の一覧 (view) と登録 (execute)。UC-03
import { readJsonBody, validateWith } from '@/lib/api/body';
import { requireAction } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { parsePageQuery } from '@/lib/api/pagination';
import { toAgentDto } from '@/lib/api/serializers';
import type { ApiSchemas } from '@/lib/api-types';
import { agentCreateSchema } from '@/lib/validations/agent';
import { agentStatus } from '@/lib/validations/common';

// 認証に依存するので静的化しない
export const dynamic = 'force-dynamic';
// status クエリの検証 (省略可)
const statusQuerySchema = agentStatus.optional();

// GET /agents (listAgents)
export const GET = route(async ({ request, principal, repos }) => {
  // view 権限
  const { tenantId } = requireAction(principal, 'view');
  // クエリを読む
  const url = new URL(request.url);
  const status = validateWith(statusQuerySchema, url.searchParams.get('status') ?? undefined);
  // 自テナントで絞って一覧する
  const page = await repos.agents.list(tenantId, parsePageQuery(url), { status });
  // DTO へ写す
  const body: ApiSchemas['AgentList'] = {
    items: page.items.map(toAgentDto),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
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
