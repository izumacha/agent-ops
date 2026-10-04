// 人が指定できるエージェントの稼働状態と、その変更を表す監査ログの操作名（唯一の定義）。
//
// **API（`POST /agents/{id}/stop` ・ `/resume`）とダッシュボードの Server Action が同じここを読む。**
// 写しを持つと「API では `agent_resumed` なのに画面からは別の操作名で記録される」形が静かに生まれ、
// 監査ログを読む側が同じ出来事を 2 種類の名前で見ることになる（§6 DRY）。
import { AuditAction } from '@/domain/audit/action';
import { AgentStatus } from '@/domain/types';

/**
 * この経路で人が指定できる状態。**`suspended` は入らない** — 自動停止はガードレールの判定が
 * アダプタの中で行うもので、人が指定してその状態へ持っていく操作は存在しない
 * （入れてしまうと「誰かが手で suspended にした」記録と自動停止の記録が区別できなくなる）。
 */
export type SettableAgentStatus = typeof AgentStatus.active | typeof AgentStatus.stopped;

/**
 * その状態変更を表す監査ログの操作名。**表で持つのは、指定できる状態を足したときに
 * typecheck が落ちるから**（条件分岐で書くと、新しい状態が既定の分岐へ黙って落ちて
 * 別の操作名で記録される）。
 */
export const AGENT_STATUS_AUDIT_ACTION: Readonly<Record<SettableAgentStatus, AuditAction>> = {
  // 止まっていたものを戻した（UC-09。手動停止と自動停止のどちらからでも active へ戻す）
  [AgentStatus.active]: AuditAction.agent_resumed,
  // 手で止めた
  [AgentStatus.stopped]: AuditAction.agent_stopped,
};
