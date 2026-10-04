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

/**
 * 画面から送られてくる操作の名前（意図）。**`stop` / `resume` の 2 つだけ**で、
 * 状態の綴り（`stopped` / `active`）をそのまま送らせない — 送らせると
 * 「`suspended` を指定できるのでは」という形が生まれる（自動停止は人が指定する操作ではない）。
 */
export const AgentStatusIntent = { stop: 'stop', resume: 'resume' } as const;
// AgentStatusIntent の値の型
export type AgentStatusIntent = (typeof AgentStatusIntent)[keyof typeof AgentStatusIntent];

/**
 * 意図から「その操作で設定する状態」への対応。**表で持つ**ので、意図を足したら typecheck が落ちる
 * （条件分岐で書くと、新しい意図が既定の分岐へ黙って落ちて別の状態へ変えてしまう）。
 */
export const AGENT_STATUS_BY_INTENT: Readonly<Record<AgentStatusIntent, SettableAgentStatus>> = {
  // 止める
  [AgentStatusIntent.stop]: AgentStatus.stopped,
  // 戻す（手動停止・自動停止のどちらからでも active へ）
  [AgentStatusIntent.resume]: AgentStatus.active,
};

/**
 * フォームから送られた値を、設定する状態へ読み替える。**知らない値は `null`**（fail-closed）。
 *
 * 画面は `AgentStatusIntent` の値しか送らないが、フォームの値は書き換えられるので
 * 受け取る側で必ず表と突き合わせる（§9 入力は信用しない）。
 */
export function settableStatusForIntent(raw: unknown): SettableAgentStatus | null {
  // 文字列でなければ読み替えられない（FormData は File も返しうる）
  if (typeof raw !== 'string') return null;
  // 表に**自身のキーとして**あるかを見る（素の添字だと `constructor` 等が値を返す）
  if (!Object.hasOwn(AGENT_STATUS_BY_INTENT, raw)) return null;
  // 表から引く
  return AGENT_STATUS_BY_INTENT[raw as AgentStatusIntent];
}
