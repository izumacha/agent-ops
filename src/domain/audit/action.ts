// 監査ログの `action` / `targetType` の語彙。**ここが唯一の定義**で、書き込み側（`recordAudit` の
// 呼び出し元）と、将来の絞り込み・画面表示が同じ値を読む。
//
// 文字列を各所に直書きしないのは §6 の「マジック文字列を避ける」そのもので、綴りが 1 文字違うと
// 同じ操作が 2 種類の名前で記録され、監査ログを読む側（人も API も）がそれを 1 つの操作として
// 数えられなくなる。しかも**書き込みは追記専用なので後から直せない**。

/** 記録する操作の名前（`<対象>.<動作>` の形にそろえる） */
export const AuditAction = {
  // ガードレールのルールが発火した（インシデントを記録した）
  guardrail_fired: 'guardrail.fired',
  // 予算の上限を超えたので中継を断った
  agent_budget_exceeded: 'agent.budget_exceeded',
  // インシデントを解決済みにした（人の操作）
  incident_resolved: 'incident.resolved',
} as const;
/** AuditAction の値の型 */
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

/** 記録する対象の種類（Prisma のモデル名にそろえる。画面から資源を引けるようにするため） */
export const AuditTargetType = {
  // エージェント（停止・復帰・予算の超過）
  agent: 'Agent',
  // インシデント（発火・解決）
  incident: 'Incident',
} as const;
/** AuditTargetType の値の型 */
export type AuditTargetType = (typeof AuditTargetType)[keyof typeof AuditTargetType];
