// 停止 (stop) と復帰 (resume) は「stop 権限で状態を 1 つ書き換えて返す」同じ形なので、ハンドラをここで組み立てる
// (権限・404 の形・DTO の写し方を 2 か所に持たない。復帰も「止める権限を持つ人」の操作。UC-09)
import { notFoundError } from '@/lib/api/errors';
import { requireAction } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import { toAgentDto } from '@/lib/api/serializers';
// 指定できる状態と監査ログの操作名の対応は、画面の Server Action と共有する 1 か所から取る
import { AGENT_STATUS_AUDIT_ACTION, type SettableAgentStatus } from '@/domain/agent-status';
import { AuditTargetType } from '@/domain/audit/action';
import { assertAuditConfigured, recordAudit } from '@/lib/audit/record';

// 指定した状態へ変える Route Handler を作る
export function setAgentStatusRoute(status: SettableAgentStatus) {
  // 認証は route() が、認可はこの中で行う
  return route<{ agentId: string }>(async ({ params, principal, repos }) => {
    // stop 権限
    const { tenantId, user } = requireAction(principal, 'stop');
    // **状態を変える前に「監査ログを書ける状態か」を確かめる** (理由は assertAuditConfigured)
    assertAuditConfigured();
    // 自テナント内で状態を変える (他テナントは 404。同じ状態への再実行も 200 で冪等)
    const agent = await repos.agents.setStatus(tenantId, params.agentId, status);
    if (!agent) throw notFoundError();
    // **操作として記録する。** 同じ状態への再実行でも 1 行残す — 監査ログが残すのは
    // 「誰がいつ何を要求したか」で、状態が動いたかどうかはその payload が持つ情報ではない
    // (「止まっているはずのエージェントに誰が resume を打ったか」は追跡したい事実そのもの)
    await recordAudit(repos, {
      tenantId,
      actorId: user.id,
      action: AGENT_STATUS_AUDIT_ACTION[status],
      targetType: AuditTargetType.agent,
      targetId: agent.id,
      // 変更後の状態だけを残す (機微情報を入れない)
      payload: { status: agent.status },
    });
    // 変更後を返す
    return Response.json(toAgentDto(agent));
  });
}
