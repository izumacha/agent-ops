// /api/v1/guardrails: ガードレールのルール一覧 (view) と登録 (admin ロール限定)。UC-08
import { readJsonBody } from '@/lib/api/body';
import { ApiError, notFoundError } from '@/lib/api/errors';
import { requireAction, requireAdminRole } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { pageQuerySchema, parseQuery } from '@/lib/api/pagination';
import { toGuardrailRuleDto, toListDto } from '@/lib/api/serializers';
import type { ApiSchemas } from '@/lib/api-types';
import {
  API_MESSAGES,
  GUARDRAIL_RULE_ROWS_MAX_PER_TENANT,
  GUARDRAIL_RULES_MAX_PER_TENANT,
} from '@/lib/constants';
import { guardrailRuleCreateSchema } from '@/lib/validations/guardrail';
import { AuditAction, AuditTargetType } from '@/domain/audit/action';
import { assertAuditConfigured, recordAudit } from '@/lib/audit/record';

// GET /guardrails (listGuardrailRules)
export const GET = route(async ({ request, principal, repos }) => {
  // view 権限 (閲覧は 3 役割すべてに許される)
  const { tenantId } = requireAction(principal, 'view');
  // limit / cursor を検証する
  const pageQuery = parseQuery(new URL(request.url), pageQuerySchema);
  // 自テナントで絞って一覧する
  const page = await repos.guardrailRules.list(tenantId, pageQuery);
  // DTO へ写す
  const body: ApiSchemas['GuardrailRuleList'] = toListDto(page, toGuardrailRuleDto);
  return Response.json(body);
});

/**
 * POST /guardrails (createGuardrailRule)
 *
 * **admin ロール限定。** ルールは「このエージェントを自動で止める条件」を決めるので、
 * 自由に作れると operator が他人のエージェントを止める条件を仕込めてしまう。停止そのものは
 * stop 権限で行えるが、「止まる条件を変える」のは運用の設定変更なので役割そのもので縛る
 * (ユーザー招待・役割変更と同じ扱い。docs/spec.md §4)。
 */
export const POST = route(async ({ request, principal, repos }) => {
  // admin ロールであること
  const { tenantId, user } = requireAdminRole(principal);
  // 本文を検証する (しきい値と集計窓の範囲は Zod が種別ごとに見る)
  const input = await readJsonBody(request, guardrailRuleCreateSchema);
  // **作る前に「監査ログを書ける状態か」を確かめる** — 作ってから記録に失敗すると、
  // 「誰が入れたか分からないルール」が残る (理由は assertAuditConfigured のコメント)
  assertAuditConfigured();
  // 判定と挿入を同じトランザクションで行う (数えてから挿入すると同時の 2 件が上限を超える)
  const created = await repos.guardrailRules.create(
    {
      tenantId,
      agentId: input.agentId ?? null,
      kind: input.kind,
      threshold: input.threshold,
      windowMinutes: input.windowMinutes,
      action: input.action,
    },
    { maxEnabled: GUARDRAIL_RULES_MAX_PER_TENANT, maxRows: GUARDRAIL_RULE_ROWS_MAX_PER_TENANT },
  );
  // 指定したエージェントが自テナントに無い (他テナントの id も同じ扱いで存在を隠す)
  if (created.status === 'agent_not_found') throw notFoundError();
  // ルール数の上限に達している (409: 状態が許さない)
  if (created.status === 'too_many_rules') {
    throw new ApiError(HTTP_STATUS.CONFLICT, API_MESSAGES.guardrailRuleLimit);
  }
  // 行数 (無効化したものを含む) の上限に達している。**別の文言を返す** —
  // 「不要なルールを削除してください」だけだと、有効なルールが 0 件なのに作れない利用者が
  // 何を消せばよいか分からない (消す対象は無効化した行の側)
  if (created.status === 'too_many_rows') {
    throw new ApiError(HTTP_STATUS.CONFLICT, API_MESSAGES.guardrailRuleRowLimit);
  }
  // **「止まる条件」の変更なので監査ログに残す。** ルールはこのシステムの制御そのものなので、
  // 誰がどの条件を入れたかが読めないと、発火の記録だけ見ても「なぜ止まったか」が辿れない
  await recordAudit(repos, {
    tenantId,
    actorId: user.id,
    action: AuditAction.guardrail_rule_created,
    targetType: AuditTargetType.guardrailRule,
    targetId: created.rule.id,
    // 判断の根拠になる設定だけを残す (機微情報は無い)
    payload: {
      agentId: created.rule.agentId,
      kind: created.rule.kind,
      threshold: created.rule.threshold,
      windowMinutes: created.rule.windowMinutes,
      action: created.rule.action,
    },
  });
  // 201 で返す
  return Response.json(toGuardrailRuleDto(created.rule), { status: HTTP_STATUS.CREATED });
});
