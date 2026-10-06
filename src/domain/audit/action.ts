// 監査ログの `action` / `targetType` の語彙。**ここが唯一の定義**で、書き込み側（`recordAudit` の
// 呼び出し元）と、将来の絞り込み・画面表示が同じ値を読む。
//
// 文字列を各所に直書きしないのは §6 の「マジック文字列を避ける」そのもので、綴りが 1 文字違うと
// 同じ操作が 2 種類の名前で記録され、監査ログを読む側（人も API も）がそれを 1 つの操作として
// 数えられなくなる。しかも**書き込みは追記専用なので後から直せない**。

/**
 * 記録する操作の名前（`<対象>.<動作>` の形にそろえる）。
 *
 * **ここに値を足したら、必ずどこかの `recordAudit` から発行する。** 発行箇所の無い語彙は
 * 「記録しているつもり」を作るだけで、実際には何も残らない（実測で `agent.budget_exceeded` が
 * 定義だけされていて、予算超過の 403 は監査ログにも台帳にも 1 行も残っていなかった）。
 * 発行漏れは `tests/audit-coverage.test.ts` がこの表から導いて落とす。
 */
export const AuditAction = {
  // ガードレールのルールが発火した（インシデントを記録した）
  guardrail_fired: 'guardrail.fired',
  // インシデントを解決済みにした（人の操作）
  incident_resolved: 'incident.resolved',
  // エージェントを手で停止した（人の操作。自動停止は guardrail.fired の payload が持つ）
  agent_stopped: 'agent.stopped',
  // 停止・自動停止からエージェントを復帰させた（人の操作。UC-09）
  agent_resumed: 'agent.resumed',
  // ガードレールのルールを登録した（「止まる条件」の変更なので記録する）
  guardrail_rule_created: 'guardrail.rule_created',
  // ガードレールのルールを削除した（同上）
  guardrail_rule_deleted: 'guardrail.rule_deleted',
  // ガードレールのルールを有効に戻した（「止まる条件」の変更なので記録する）
  guardrail_rule_enabled: 'guardrail.rule_enabled',
  // ガードレールのルールを無効にした（**発火記録を持つルールを止める唯一の手段**なので、
  // 「いつ誰が止める条件を外したか」が辿れるようにする）
  guardrail_rule_disabled: 'guardrail.rule_disabled',
  // 契約プランが変わった（Step6）。**人の操作（プラットフォーム管理者）と課金事業者の Webhook の
  // 2 経路があり、どちらも同じ名前で残す** — プランは上限と機能の可否を決めるので、
  // 「いつ何が変わったか」が辿れないと 409 / 403 の原因を後から説明できない。
  // 誰がやったかは `actorId`（Webhook 由来なら null）と payload の `source` が示す
  tenant_plan_changed: 'tenant.plan_changed',
} as const;
/** AuditAction の値の型 */
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

/** 記録する対象の種類（Prisma のモデル名にそろえる。画面から資源を引けるようにするため） */
export const AuditTargetType = {
  // エージェント（手動の停止・復帰）
  agent: 'Agent',
  // インシデント（発火・解決）
  incident: 'Incident',
  // ガードレールのルール（登録・削除）
  guardrailRule: 'GuardrailRule',
  // テナント（契約プランの変更。Step6）
  tenant: 'Tenant',
} as const;
/** AuditTargetType の値の型 */
export type AuditTargetType = (typeof AuditTargetType)[keyof typeof AuditTargetType];
