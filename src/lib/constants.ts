// UI 文言と enum ラベルの一元管理 (§6)。画面・API のエラー文言はここから引く
import { AgentStatus, Role } from '@/domain/types';

// アプリ名 (画面タイトル等で使う)
export const APP_NAME = 'Agent Ops';

// 役割の日本語ラベル
export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  [Role.viewer]: '閲覧者', // viewer
  [Role.operator]: '運用者', // operator
  [Role.admin]: '管理者', // admin
};

// エージェント状態の日本語ラベル
export const AGENT_STATUS_LABELS: Readonly<Record<AgentStatus, string>> = {
  [AgentStatus.active]: '稼働中', // active
  [AgentStatus.stopped]: '停止中', // stopped
  [AgentStatus.suspended]: '自動停止', // suspended
};
