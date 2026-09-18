// /api/v1/agents/{agentId}/resume: 復帰 (stop 権限)。stopped / suspended のどちらからも active へ戻す
import { notFoundError } from '@/lib/api/errors';
import { requireAction } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import { toAgentDto } from '@/lib/api/serializers';
import { AgentStatus } from '@/domain/types';

// POST /agents/{agentId}/resume (resumeAgent)
export const POST = route<{ agentId: string }>(async ({ params, principal, repos }) => {
  // stop 権限 (復帰も「止める権限を持つ人」の操作。UC-09)
  const { tenantId } = requireAction(principal, 'stop');
  // 自テナント内で active にする (他テナントは 404)
  const agent = await repos.agents.setStatus(tenantId, params.agentId, AgentStatus.active);
  if (!agent) throw notFoundError();
  // 復帰後を返す
  return Response.json(toAgentDto(agent));
});
