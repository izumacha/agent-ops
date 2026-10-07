// seed が投入するデモ用データの定義 (値だけを持ち、DB へは触れない)。
// 分けている理由: seed.ts は読み込むだけで main() が走って DB へ接続してしまうため、
// 「デモアカウントは最小権限を既定にする」(§15) といった不変条件をテストから確かめられない。
// 値をここへ出せば tests/seed-data.test.ts が DB 無しで検査できる
import { Plan, Provider, Role } from '../src/domain/types';

// デモテナントの表示名
export const DEMO_TENANT_NAME = 'デモテナント';
// デモテナントの契約プラン。
//
// **pro にしてある。** README の quickstart は監査ログの改ざん検証 (`GET /audit-logs/verify`) と
// `GET /billing` の出力例まで通して書いてあり、free だとその 2 つが 403 / 別の値になって
// 「クローンして手順どおりに叩いたら動かない」状態になる (Step7 の受け入れ基準「クリーン環境で
// 5 分以内にデモ動作」が掛かる経路)。既存の配備も
// マイグレーション `20261006000100_promote_existing_tenants_to_pro` で pro なので、デモだけが
// free だと説明と実物がずれる。**free の挙動はユニット・API テストが担保している**ので、
// デモデータで確かめる必要は無い。
//
// **プランは役割とは別の軸なので §15 の「最小権限」とは衝突しない** — 閲覧専用の利用者は
// プランが pro でも書き込めない (権限は `PERMISSIONS` が決める)。
export const DEMO_TENANT_PLAN = Plan.pro;

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
