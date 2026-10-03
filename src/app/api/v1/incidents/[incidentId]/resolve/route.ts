// /api/v1/incidents/{incidentId}/resolve: インシデントを解決済みにする (admin ロール限定)。UC-09
import { ApiError, notFoundError } from '@/lib/api/errors';
import { requireAdminRole } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { toIncidentDto } from '@/lib/api/serializers';
import { API_MESSAGES } from '@/lib/constants';
import { AuditAction, AuditTargetType } from '@/domain/audit/action';
import { assertAuditConfigured, recordAudit } from '@/lib/audit/record';

/**
 * POST /incidents/{incidentId}/resolve (resolveIncident)
 *
 * **エージェントの復帰は別操作** (POST /agents/{agentId}/resume)。「原因に対処した」と
 * 「また動かしてよい」は別の判断で、まとめると片方だけ行いたい運用 (原因は分かったが
 * まだ動かしたくない / 急いで動かすが原因は追い続ける) ができなくなる。
 *
 * **解決は 1 度だけ成功する。** 条件付き更新で「開いているものだけ」を閉じるので、同時に
 * 2 回呼ばれても片方が 409 になる (読んでから書く形だと両方が成功して監査ログが二重に残る)。
 */
export const POST = route<{ incidentId: string }>(async ({ params, principal, repos }) => {
  // admin ロールであること (復帰の判断と同じ重さの操作)
  const { tenantId, user } = requireAdminRole(principal);
  // **状態を変える前に「監査ログを書ける状態か」を確かめる。** 変えてから記録に失敗すると、
  // 解決済みなのに記録が無く、再試行は 409 `already_resolved` で永久に成功しない
  // (理由は assertAuditConfigured のコメント)
  assertAuditConfigured();
  // 自テナント内で解決する
  const result = await repos.incidents.resolve(tenantId, params.incidentId);
  // 他テナントの id・存在しない id は 404
  if (result === 'not_found') throw notFoundError();
  // 既に解決済み (409: 状態が許さない)
  if (result === 'already_resolved') {
    throw new ApiError(HTTP_STATUS.CONFLICT, API_MESSAGES.incidentAlreadyResolved);
  }
  // 解決後の行を読み直す (更新は条件付き updateMany なので行を返さない)
  const incident = await repos.incidents.findById(tenantId, params.incidentId);
  // 直後に消えていれば 404 (テナント削除と同時に呼ばれた場合)
  if (incident === null) throw notFoundError();
  // **監査ログを書く。** ここは自動発火と違って人の操作なので、書けなければ 503 で失敗させる
  // (UC-09 の事後条件「監査ログに残る」を守れないまま成功を返さない。§9 fail-closed)
  await recordAudit(repos, {
    tenantId,
    actorId: user.id,
    action: AuditAction.incident_resolved,
    targetType: AuditTargetType.incident,
    targetId: incident.id,
    payload: { agentId: incident.agentId, ruleId: incident.ruleId },
  });
  // 解決後の状態を返す
  return Response.json(toIncidentDto(incident));
});
