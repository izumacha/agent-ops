// /api/v1/guardrails/{ruleId}: ガードレールのルールの無効化と削除 (どちらも admin ロール限定)。UC-08
import { readJsonBody } from '@/lib/api/body';
import { ApiError, notFoundError } from '@/lib/api/errors';
import { requireAdminRole } from '@/lib/api/guard';
import { noContent, route } from '@/lib/api/handler';
import { HTTP_STATUS } from '@/lib/api/http-status';
import type { ApiSchemas } from '@/lib/api-types';
import { API_MESSAGES } from '@/lib/constants';
import { guardrailRuleLimitsFor } from '@/domain/plan';
import { AuditAction, AuditTargetType } from '@/domain/audit/action';
import { assertAuditConfigured, recordAudit } from '@/lib/audit/record';
import { toGuardrailRuleDto } from '@/lib/api/serializers';
import { guardrailRuleUpdateSchema } from '@/lib/validations/guardrail';

// その切り替えを表す監査ログの操作名。**表で持つのは、値が増えたときに typecheck が落ちるから**
// (条件分岐で書くと、新しい値が既定の分岐へ黙って落ちて別の操作名で記録される。
//  エージェントの状態変更 `AUDIT_ACTION_BY_STATUS` と同じ形)
const AUDIT_ACTION_BY_ENABLED: Readonly<Record<'true' | 'false', AuditAction>> = {
  // 判定の対象に戻した
  true: AuditAction.guardrail_rule_enabled,
  // 判定の対象から外した (発火記録を持つルールを止める唯一の手段)
  false: AuditAction.guardrail_rule_disabled,
};

/**
 * PATCH /guardrails/{ruleId} (updateGuardrailRule)
 *
 * **発火記録を持つルールは削除できないので、設定を誤ったルールを止める手段はこれだけ。**
 * これが無かったあいだ、しきい値を誤った `stop` のルールはインシデントを解決して
 * エージェントを復帰させても次の中継で再び発火し、回復には DB の直接操作が必要だった。
 *
 * **切り替えられるのは `enabled` だけ** (理由は `guardrailRuleUpdateSchema`)。
 * **冪等** — 同じ値を 2 度送っても 200 で現在の行を返す (2 度押しや再試行で 409 にしない)。
 */
export const PATCH = route<{ ruleId: string }>(async ({ request, params, principal, repos }) => {
  // admin ロールであること (作成・削除と同じ理由。「止まる条件」を変える操作)
  const { tenantId, user, plan } = requireAdminRole(principal);
  // 本文を検証する (415 → 413 → 400 → 422 の順)
  const input = await readJsonBody(request, guardrailRuleUpdateSchema);
  // **変える前に「監査ログを書ける状態か」を確かめる** — 変えてから記録に失敗すると、
  // 「いつ誰が止める条件を外したか」が辿れないまま条件だけが変わる (理由は assertAuditConfigured)
  assertAuditConfigured();
  // 自テナント内で切り替える (他テナントの id・存在しない id は 404 で隠す)。
  // **有効へ戻すときは有効なルールの上限を数え直す** — 数えないと「上限まで作る →
  // 全部無効化する → また作る → 最初の分を戻す」で有効なルールが上限を超え、中継 1 回ごとの
  // 集計がその倍数まで重くなる (上限は行数の天井の側でしか縛られていない状態になる)
  const result = await repos.guardrailRules.setEnabled(
    tenantId,
    params.ruleId,
    input.enabled,
    // **有効側の上限は契約プランから引く（Step6）**
    guardrailRuleLimitsFor(plan).maxEnabled,
  );
  if (result.status === 'not_found') throw notFoundError();
  // 有効なルールの上限に達している (409: 状態が許さない。作成と同じ文言)
  if (result.status === 'too_many_rules') {
    throw new ApiError(HTTP_STATUS.CONFLICT, API_MESSAGES.guardrailRuleLimit);
  }
  // 切り替えた後の行
  const rule = result.rule;
  // 操作として記録する (同じ値への再実行でも 1 行残す — 記録するのは「誰がいつ何を要求したか」)
  await recordAudit(repos, {
    tenantId,
    actorId: user.id,
    action: AUDIT_ACTION_BY_ENABLED[input.enabled ? 'true' : 'false'],
    targetType: AuditTargetType.guardrailRule,
    targetId: rule.id,
    // 切り替えた後の状態 (機微情報は入れない)
    payload: { enabled: rule.enabled },
  });
  // 切り替えた後の行を返す
  const body: ApiSchemas['GuardrailRule'] = toGuardrailRuleDto(rule);
  return Response.json(body);
});

/**
 * DELETE /guardrails/{ruleId} (deleteGuardrailRule)
 *
 * **発火記録を持つルールは削除できない (409)。** DB の Restrict FK が同じ判定をしている。
 * 記録からルールを辿れなくなると「何がなぜ止めたのか」が読めなくなり、UC-09 の復帰の判断が
 * できない。不要になったルールは削除ではなく無効化で扱う想定 (Step5 の設定画面)。
 */
export const DELETE = route<{ ruleId: string }>(async ({ params, principal, repos }) => {
  // admin ロールであること (作成と同じ理由)
  const { tenantId, user } = requireAdminRole(principal);
  // **消す前に「監査ログを書ける状態か」を確かめる** — 消してから記録に失敗すると、
  // ルールも記録も残らず「いつ誰が外したか」が辿れない (理由は assertAuditConfigured)
  assertAuditConfigured();
  // 自テナント内で削除する
  const result = await repos.guardrailRules.delete(tenantId, params.ruleId);
  // 他テナントの id・存在しない id は 404
  if (result === 'not_found') throw notFoundError();
  // 発火記録があるので消せない
  if (result === 'restricted') {
    throw new ApiError(HTTP_STATUS.CONFLICT, API_MESSAGES.guardrailRuleHasIncidents);
  }
  // **削除も「止まる条件」の変更なので記録する。** 消えた行の設定はもう読めないので、
  // 少なくとも「誰がどの id を外したか」を残す (ルールの中身は作成時の記録が持っている)
  await recordAudit(repos, {
    tenantId,
    actorId: user.id,
    action: AuditAction.guardrail_rule_deleted,
    targetType: AuditTargetType.guardrailRule,
    targetId: params.ruleId,
    // 削除では残す値が無い (対象は targetId が指す)
    payload: null,
  });
  // 本文無し
  return noContent();
});
