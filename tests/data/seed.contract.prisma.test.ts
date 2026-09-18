// seed の投入手順 (prisma/seed-apply.ts) の契約テスト (実 PostgreSQL)。
//
// **値だけを見るテストでは足りない**: `tests/seed-data.test.ts` は定義 (prisma/seed-data.ts) が
// §15「デモアカウントは閲覧専用の最小権限ロールを既定にする」を満たすことを固定するが、
// 投入する側がその定義を全部使う保証が無い。実測では、ユーザーを回すループを
// `DEMO_USERS.slice(0, 1)` に変えて閲覧専用ユーザーを 1 人も作らないようにしても全件緑だった
// (CI の `npm run db:seed` も 2 回流すだけで、入った中身は誰も見ていない)。
// ここで実 DB に対して「定義どおりに入ったか」と「2 回流しても同じか (冪等)」を確かめる。
// RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で全テーブルを TRUNCATE するため開発 DB を指さないこと
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySeed } from '../../prisma/seed-apply';
import { DEMO_AGENT, DEMO_TENANT_NAME, DEMO_USERS } from '../../prisma/seed-data';
import { DEFAULT_TENANT_ID } from '@/domain/tenant';
// 接続先が契約テスト専用 DB であることの確認 (入口ガード・setupFiles と同じ関数を呼ぶ)
import { runContractDatabaseGuard } from '../../scripts/lib/contract-database.mjs';

// 明示フラグが無ければ丸ごとスキップする
const ENABLED = process.env.RUN_PRISMA_CONTRACT === '1';

describe.skipIf(!ENABLED)('seed の投入手順', () => {
  // 実 DB へのクライアント (本番と同じ遅延生成 Proxy)
  let client: typeof import('@/lib/prisma').prisma;

  // 接続する (生成物へ依存するモジュールはここで初めて読む)
  beforeAll(async () => {
    // 接続先が専用 DB であること (TRUNCATE する前に確かめる)
    runContractDatabaseGuard();
    // singleton を読む
    const { prisma } = await import('@/lib/prisma');
    client = prisma;
  });

  // 全テーブルを空にする (Tenant を起点に CASCADE で子も消える)
  beforeEach(async () => {
    // 値を埋め込まないタグ付きテンプレートで流す ($executeRawUnsafe は実行時ガードが禁止している)
    await client.$executeRaw`TRUNCATE TABLE "Tenant" CASCADE`;
  });

  // 切断する
  afterAll(async () => {
    await client?.$disconnect();
  });

  it('定義したデモユーザーが 1 人残らず、役割ごと投入される', async () => {
    // 空の DB へ投入する
    await applySeed(client);
    // 入ったユーザーを (メール, 役割) の並びで取り出す
    const users = await client.user.findMany({
      where: { tenantId: DEFAULT_TENANT_ID },
      select: { email: true, role: true },
      orderBy: { email: 'asc' },
    });
    // 定義と過不足なく一致すること (1 人でも落とすとここで落ちる)
    expect(users).toEqual(
      [...DEMO_USERS]
        .map((user) => ({ email: user.email, role: user.role }))
        .sort((a, b) => (a.email < b.email ? -1 : 1)),
    );
  });

  it('テナントとサンプルエージェントも定義どおりに入る', async () => {
    // 投入する
    await applySeed(client);
    // テナント名
    const tenant = await client.tenant.findUnique({ where: { id: DEFAULT_TENANT_ID } });
    expect(tenant?.name).toBe(DEMO_TENANT_NAME);
    // エージェント (名前・プロバイダ・モデル)
    const agents = await client.agent.findMany({ where: { tenantId: DEFAULT_TENANT_ID } });
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe(DEMO_AGENT.name);
    expect(agents[0].provider).toBe(DEMO_AGENT.provider);
    expect(agents[0].model).toBe(DEMO_AGENT.model);
  });

  it('2 回流しても同じ状態になる (冪等。CI が 2 回流して確かめているのと同じ性質)', async () => {
    // 2 回続けて投入する
    await applySeed(client);
    await applySeed(client);
    // 行が増えていないこと
    expect(await client.user.count({ where: { tenantId: DEFAULT_TENANT_ID } })).toBe(
      DEMO_USERS.length,
    );
    expect(await client.agent.count({ where: { tenantId: DEFAULT_TENANT_ID } })).toBe(1);
    expect(await client.tenant.count()).toBe(1);
  });
});
