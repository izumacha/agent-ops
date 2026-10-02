// /api/v1/guardrails/{ruleId}: ガードレールのルール削除 (admin ロール限定)。UC-08
import { ApiError, notFoundError } from '@/lib/api/errors';
import { requireAdminRole } from '@/lib/api/guard';
import { noContent, route } from '@/lib/api/handler';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { API_MESSAGES } from '@/lib/constants';

/**
 * DELETE /guardrails/{ruleId} (deleteGuardrailRule)
 *
 * **発火記録を持つルールは削除できない (409)。** DB の Restrict FK が同じ判定をしている。
 * 記録からルールを辿れなくなると「何がなぜ止めたのか」が読めなくなり、UC-09 の復帰の判断が
 * できない。不要になったルールは削除ではなく無効化で扱う想定 (Step5 の設定画面)。
 */
export const DELETE = route<{ ruleId: string }>(async ({ params, principal, repos }) => {
  // admin ロールであること (作成と同じ理由)
  const { tenantId } = requireAdminRole(principal);
  // 自テナント内で削除する
  const result = await repos.guardrailRules.delete(tenantId, params.ruleId);
  // 他テナントの id・存在しない id は 404
  if (result === 'not_found') throw notFoundError();
  // 発火記録があるので消せない
  if (result === 'restricted') {
    throw new ApiError(HTTP_STATUS.CONFLICT, API_MESSAGES.guardrailRuleHasIncidents);
  }
  // 本文無し
  return noContent();
});
