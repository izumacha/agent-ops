// seed が投入するデモデータ (prisma/seed-data.ts) の不変条件。
// 実測では、デモの閲覧者ユーザーの役割を admin に変えても lint・typecheck・全テストが緑のままだった
// (seed は DB へ接続するので読み込むテストが書けず、誰も値を見ていなかった)。
// §15「デモアカウントは閲覧専用の最小権限ロールを既定にする」を機械的に守る
import { describe, expect, it } from 'vitest';
import { DEMO_AGENT, DEMO_TENANT_NAME, DEMO_USERS } from '../prisma/seed-data';
import { Role } from '@/domain/types';

describe('デモ用の seed データ', () => {
  it('管理者は 1 人だけで、閲覧専用のユーザーがいる (デモは最小権限を既定にする §15)', () => {
    // 役割ごとの人数を数える
    const admins = DEMO_USERS.filter((user) => user.role === Role.admin);
    const viewers = DEMO_USERS.filter((user) => user.role === Role.viewer);
    // 管理者はテナントを運用するのに必要な 1 人だけ
    expect(admins).toHaveLength(1);
    // デモ操作・スクリーンショット用の閲覧専用アカウントがある
    expect(viewers.length).toBeGreaterThan(0);
  });

  it('メールアドレスは実在しないドメインだけを使う (§9 実在のアドレスを書かない)', () => {
    // すべて example.com (RFC 2606 の予約ドメイン)
    for (const user of DEMO_USERS) {
      expect(user.email, `${user.email} が予約ドメインでない`).toMatch(/@example\.com$/);
    }
  });

  it('メールアドレスが重複していない (upsert の鍵になるため)', () => {
    // 重複があるとテナント内一意の鍵で上書きし合う
    const emails = DEMO_USERS.map((user) => user.email);
    expect(new Set(emails).size).toBe(emails.length);
  });

  it('テナント名とエージェント名が空でない', () => {
    // 表示名が空だと画面・一覧で何も見えない
    expect(DEMO_TENANT_NAME.length).toBeGreaterThan(0);
    expect(DEMO_AGENT.name.length).toBeGreaterThan(0);
  });
});
