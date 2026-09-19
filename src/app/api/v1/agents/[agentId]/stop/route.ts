// /api/v1/agents/{agentId}/stop: 手動停止 (stop 権限)。停止済みへの再実行も 200 (冪等)
import { AgentStatus } from '@/domain/types';
import { setAgentStatusRoute } from '../set-status-route';

// POST /agents/{agentId}/stop (stopAgent)
export const POST = setAgentStatusRoute(AgentStatus.stopped);
