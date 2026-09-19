// /api/v1/agents/{agentId}/resume: 復帰 (stop 権限)。stopped / suspended のどちらからも active へ戻す
import { AgentStatus } from '@/domain/types';
import { setAgentStatusRoute } from '../set-status-route';

// POST /agents/{agentId}/resume (resumeAgent)
export const POST = setAgentStatusRoute(AgentStatus.active);
