// seed が投入するデモ用データの定義 (値だけを持ち、DB へは触れない)。
// 分けている理由: seed.ts は読み込むだけで main() が走って DB へ接続してしまうため、
// 「デモアカウントは最小権限を既定にする」(§15) といった不変条件をテストから確かめられない。
// 値をここへ出せば tests/seed-data.test.ts が DB 無しで検査できる
import { Plan, Provider, Role } from '../src/domain/types';

// デモテナントの表示名
export const DEMO_TENANT_NAME = 'デモテナント';
// デモテナントの契約プラン (無料枠)
export const DEMO_TENANT_PLAN = Plan.free;

// デモユーザー (実在しないドメイン example.com のアドレスだけを使う §15)。
// **閲覧専用を既定にし、管理者は必要最小限の 1 人だけ置く** — スクリーンショットやデモ操作は
// 閲覧者アカウントで行う想定で、全員を admin にするとデモ環境がそのまま書き込み可能になる
export const DEMO_USERS = [
  { email: 'admin@example.com', name: '管理者', role: Role.admin },
  { email: 'viewer@example.com', name: '閲覧者', role: Role.viewer },
] as const;

// デモ用のサンプルエージェント
export const DEMO_AGENT = {
  name: 'サポート回答ボット',
  description: '問い合わせに一次回答するエージェント (デモ)',
  provider: Provider.anthropic,
  model: 'claude-sonnet-4-6',
} as const;
