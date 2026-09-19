// 停止 (stop) と復帰 (resume) は「stop 権限で状態を 1 つ書き換えて返す」同じ形なので、ハンドラをここで組み立てる
// (権限・404 の形・DTO の写し方を 2 か所に持たない。復帰も「止める権限を持つ人」の操作。UC-09)
import { notFoundError } from '@/lib/api/errors';
import { requireAction } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import { toAgentDto } from '@/lib/api/serializers';
import type { AgentStatus } from '@/domain/types';

// 指定した状態へ変える Route Handler を作る
export function setAgentStatusRoute(status: AgentStatus) {
  // 認証は route() が、認可はこの中で行う
  return route<{ agentId: string }>(async ({ params, principal, repos }) => {
    // stop 権限
    const { tenantId } = requireAction(principal, 'stop');
    // 自テナント内で状態を変える (他テナントは 404。同じ状態への再実行も 200 で冪等)
    const agent = await repos.agents.setStatus(tenantId, params.agentId, status);
    if (!agent) throw notFoundError();
    // 変更後を返す
    return Response.json(toAgentDto(agent));
  });
}
