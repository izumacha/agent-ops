// /api/v1/agents/{agentId}: 取得 (view) / 更新 (execute) / 削除 (stop)
import { readJsonBody } from '@/lib/api/body';
import { conflictError, notFoundError } from '@/lib/api/errors';
import { requireAction } from '@/lib/api/guard';
import { noContent, route } from '@/lib/api/handler';
import { toAgentDto } from '@/lib/api/serializers';
import { API_MESSAGES } from '@/lib/constants';
import { agentUpdateSchema } from '@/lib/validations/agent';

// GET /agents/{agentId} (getAgent)
export const GET = route<{ agentId: string }>(async ({ params, principal, repos }) => {
  // view 権限
  const { tenantId } = requireAction(principal, 'view');
  // 自テナント内で引く (他テナントは 404)
  const agent = await repos.agents.findById(tenantId, params.agentId);
  if (!agent) throw notFoundError();
  // DTO で返す
  return Response.json(toAgentDto(agent));
});

// PATCH /agents/{agentId} (updateAgent)
export const PATCH = route<{ agentId: string }>(async ({ request, params, principal, repos }) => {
  // execute 権限
  const { tenantId } = requireAction(principal, 'execute');
  // 本文を検証する (省略は変更しない、null は未設定へ戻す)
  const patch = await readJsonBody(request, agentUpdateSchema);
  // 自テナント内で更新する (他テナントは 404、名前重複は 422)
  const agent = await repos.agents.update(tenantId, params.agentId, patch);
  if (!agent) throw notFoundError();
  // 更新後を返す
  return Response.json(toAgentDto(agent));
});

// DELETE /agents/{agentId} (deleteAgent): 履歴があるエージェントは 409 (stop を使う)
export const DELETE = route<{ agentId: string }>(async ({ params, principal, repos }) => {
  // stop 権限
  const { tenantId } = requireAction(principal, 'stop');
  // 自テナント内で削除する
  const result = await repos.agents.delete(tenantId, params.agentId);
  // 結果ごとに応答を分ける
  if (result === 'not_found') throw notFoundError();
  if (result === 'restricted') throw conflictError(API_MESSAGES.agentHasHistory);
  // 本文無し
  return noContent();
});
