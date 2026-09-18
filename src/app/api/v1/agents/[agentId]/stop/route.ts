// /api/v1/agents/{agentId}/stop: 手動停止 (stop 権限)。停止済みへの再実行も 200 (冪等)
import { notFoundError } from '@/lib/api/errors';
import { requireAction } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import { toAgentDto } from '@/lib/api/serializers';
import { AgentStatus } from '@/domain/types';

// POST /agents/{agentId}/stop (stopAgent)
export const POST = route<{ agentId: string }>(async ({ params, principal, repos }) => {
  // stop 権限
  const { tenantId } = requireAction(principal, 'stop');
  // 自テナント内で stopped にする (他テナントは 404)
  const agent = await repos.agents.setStatus(tenantId, params.agentId, AgentStatus.stopped);
  if (!agent) throw notFoundError();
  // 停止後を返す
  return Response.json(toAgentDto(agent));
});
