// 利用イベント (UsageEvent) の契約テスト (実 PostgreSQL)。
// **memory アダプタでは見えないもの**をここで固定する:
//   - 日次集計の SQL (date_trunc) が memory の JS 集計と同じ結果を返すこと
//   - その日境界がセッションのタイムゾーン設定に左右されないこと (下の「タイムゾーン」のケース)
//   - 記録がテナント境界と複合 FK (tenantId, agentId) を越えないこと
//   - BIGINT の料金が桁を落とさずに合計されること
// RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で全テーブルを TRUNCATE するため開発 DB を指さない
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryRepos } from '@/data/adapters/memory';
import type { DailyUsageTotal, Repositories, UsageEventRecord } from '@/data/ports';
import { Provider } from '@/domain/types';
import { userTokenExpiresAt } from '@/lib/tokens';
import { runContractDatabaseGuard } from '../../scripts/lib/contract-database.mjs';

// 明示フラグが無ければ丸ごとスキップする
const ENABLED = process.env.RUN_PRISMA_CONTRACT === '1';

// テストで発行するトークンの有効期間 (日)
const TOKEN_TTL_DAYS = 1;
// 集計に使うモデル名 (料金表とは独立。集計は記録された値を足すだけ)
const MODEL = 'claude-sonnet-4-6';

// テナント + エージェントを 1 組作る
async function makeTenantWithAgent(repos: Repositories, label: string) {
  // テナントと初期 admin
  const created = await repos.tenants.createWithAdmin({
    name: `テナント${label}`,
    admin: { email: `admin-${label}@example.com`, name: `管理者${label}` },
    token: {
      prefix: 'aop_u_test',
      tokenHash: `hash-${label}-${Date.now()}-${Math.random()}`,
      name: '初期',
      expiresAt: userTokenExpiresAt(TOKEN_TTL_DAYS),
    },
  });
  // そのテナントのエージェント
  const agent = await repos.agents.create({
    tenantId: created.tenant.id,
    name: `bot-${label}`,
    description: null,
    provider: Provider.anthropic,
    model: MODEL,
    budgetMicroUsd: null,
  });
  // テナント id とエージェントを返す
  return { tenantId: created.tenant.id, agent };
}

describe.skipIf(!ENABLED)('利用イベントの契約', () => {
  // 実 DB のクライアントとリポジトリ (本番と同じ Composition Root 経由)
  let client: typeof import('@/lib/prisma').prisma;
  let repos: Repositories;

  // 接続する (生成物へ依存するモジュールはここで初めて読む)
  beforeAll(async () => {
    // 接続先が専用 DB であること (TRUNCATE する前に確かめる)
    runContractDatabaseGuard();
    const [{ prisma }, { getRepos }] = await Promise.all([
      import('@/lib/prisma'),
      import('@/data'),
    ]);
    client = prisma;
    repos = await getRepos();
  });

  // 全テーブルを空にする
  beforeEach(async () => {
    await client.$executeRaw`TRUNCATE TABLE "Tenant" CASCADE`;
  });

  // 切断する
  afterAll(async () => {
    await client?.$disconnect();
  });

  // 指定した日時の行を DB へ直接入れる (createdAt を固定したいので Port ではなくクライアントを使う)
  async function insertAt(options: {
    tenantId: string;
    agentId: string;
    createdAt: string;
    inputTokens: number;
    outputTokens: number;
    costMicroUsd: bigint;
  }): Promise<void> {
    // 行を作る
    await client.usageEvent.create({
      data: {
        tenantId: options.tenantId,
        agentId: options.agentId,
        provider: Provider.anthropic,
        model: MODEL,
        inputTokens: options.inputTokens,
        outputTokens: options.outputTokens,
        costMicroUsd: options.costMicroUsd,
        latencyMs: 5,
        statusCode: 200,
        createdAt: new Date(options.createdAt),
      },
    });
  }

  it('記録した行は入力どおりに保存され、テナント境界の外へは書けない', async () => {
    // 2 テナント
    const a = await makeTenantWithAgent(repos, 'A');
    const b = await makeTenantWithAgent(repos, 'B');
    // 自テナントのエージェントへの記録は通る
    const input = {
      tenantId: a.tenantId,
      agentId: a.agent.id,
      provider: Provider.anthropic,
      model: MODEL,
      inputTokens: 123,
      outputTokens: 456,
      costMicroUsd: 7_890n,
      latencyMs: 42,
      statusCode: 200,
    };
    const recorded = await repos.usageEvents.record(input);
    // 入力の各項目がそのまま保存されている (項目を取り違えても型検査は通るので値で確かめる)
    expect(recorded).not.toBeNull();
    for (const [key, value] of Object.entries(input)) {
      expect(recorded?.[key as keyof UsageEventRecord], `${key} が入力どおりでない`).toEqual(value);
    }
    // 他テナントのエージェントを指す記録は複合 FK が拒否する (null が返る)
    expect(await repos.usageEvents.record({ ...input, agentId: b.agent.id })).toBeNull();
  });

  it('日次集計は UTC の日ごとで、他テナントの行を含まない', async () => {
    // 2 テナント
    const a = await makeTenantWithAgent(repos, 'A');
    const b = await makeTenantWithAgent(repos, 'B');
    // テナント A: 同じ日に 2 件 (日付の端を含む) と翌日に 1 件
    await insertAt({
      tenantId: a.tenantId,
      agentId: a.agent.id,
      createdAt: '2026-03-01T00:00:00Z',
      inputTokens: 10,
      outputTokens: 20,
      costMicroUsd: 100n,
    });
    await insertAt({
      tenantId: a.tenantId,
      agentId: a.agent.id,
      createdAt: '2026-03-01T23:59:59.999Z',
      inputTokens: 1,
      outputTokens: 2,
      costMicroUsd: 50n,
    });
    await insertAt({
      tenantId: a.tenantId,
      agentId: a.agent.id,
      createdAt: '2026-03-02T00:00:00Z',
      inputTokens: 7,
      outputTokens: 8,
      costMicroUsd: 25n,
    });
    // テナント B にも同じ日に 1 件 (混ざらないこと)
    await insertAt({
      tenantId: b.tenantId,
      agentId: b.agent.id,
      createdAt: '2026-03-01T12:00:00Z',
      inputTokens: 999,
      outputTokens: 999,
      costMicroUsd: 999n,
    });
    // テナント A の 2 日分を集計する
    const totals = await repos.usageEvents.dailyTotals(a.tenantId, {
      start: new Date('2026-03-01T00:00:00Z'),
      endExclusive: new Date('2026-03-03T00:00:00Z'),
    });
    // 日ごとの合計 (他テナントは入らない)
    expect(totals).toEqual([
      { day: '2026-03-01', requests: 2, inputTokens: 11, outputTokens: 22, costMicroUsd: 150n },
      { day: '2026-03-02', requests: 1, inputTokens: 7, outputTokens: 8, costMicroUsd: 25n },
    ] satisfies DailyUsageTotal[]);
  });

  it('memory アダプタと同じ結果を返す (SQL と JS の集計がずれない)', async () => {
    // 同じ入力を両方のアダプタへ入れる
    const a = await makeTenantWithAgent(repos, 'A');
    // memory 側の用意 (同じ形のテナント・エージェント)
    const memory = createMemoryRepos();
    const memoryTenant = await memory.tenants.createWithAdmin({
      name: 'テナントA',
      admin: { email: 'admin-a@example.com', name: '管理者A' },
      token: {
        prefix: 'aop_u_test',
        tokenHash: 'hash-memory',
        name: '初期',
        expiresAt: userTokenExpiresAt(TOKEN_TTL_DAYS),
      },
    });
    const memoryAgent = await memory.agents.create({
      tenantId: memoryTenant.tenant.id,
      name: 'bot-A',
      description: null,
      provider: Provider.anthropic,
      model: MODEL,
      budgetMicroUsd: null,
    });
    // 入れる行 (日をまたぐ・同じ日に複数・端の時刻)
    const rows = [
      { createdAt: '2026-03-01T00:00:00Z', inputTokens: 3, outputTokens: 4, costMicroUsd: 11n },
      { createdAt: '2026-03-01T23:59:59.999Z', inputTokens: 5, outputTokens: 6, costMicroUsd: 22n },
      { createdAt: '2026-03-03T09:00:00Z', inputTokens: 7, outputTokens: 8, costMicroUsd: 33n },
    ];
    for (const row of rows) {
      // prisma 側は createdAt を指定して直接入れる
      await insertAt({ tenantId: a.tenantId, agentId: a.agent.id, ...row });
      // memory 側は表へ直接入れる (同じ createdAt にするため)
      // id は 1 度だけ採番する (キーと id で別々に呼ぶと 2 つの値がずれる)
      const memoryId = memory.store.nextId('usage');
      memory.store.usageEvents.set(memoryId, {
        id: memoryId,
        tenantId: memoryTenant.tenant.id,
        agentId: memoryAgent.id,
        provider: Provider.anthropic,
        model: MODEL,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        costMicroUsd: row.costMicroUsd,
        latencyMs: 5,
        statusCode: 200,
        createdAt: new Date(row.createdAt),
      });
    }
    // 同じ期間で両方を集計する
    const window = {
      start: new Date('2026-03-01T00:00:00Z'),
      endExclusive: new Date('2026-03-04T00:00:00Z'),
    };
    const fromDb = await repos.usageEvents.dailyTotals(a.tenantId, window);
    const fromMemory = await memory.usageEvents.dailyTotals(memoryTenant.tenant.id, window);
    // 日付・件数・合計がすべて一致する
    expect(fromDb).toEqual(fromMemory);
  });

  it('日の境目はセッションのタイムゾーン設定に左右されない', async () => {
    // **この検査だけが見えるもの**: 集計 SQL の date_trunc はセッションのタイムゾーンで日を切る。
    // `createdAt` の列は timestamp without time zone (= UTC の壁時計) なので、SQL 側で
    // `AT TIME ZONE 'UTC'` を挟むと「UTC の壁時計を現地時刻として読み直す」ことになり、
    // 接続のタイムゾーンが UTC 以外のとき日がずれる (実測: Asia/Tokyo で 1 日ぶん繰り上がった)。
    // CI もローカルも既定は UTC なので、通常の集計テストではこのずれが一切現れない
    const a = await makeTenantWithAgent(repos, 'A');
    // 同じ UTC の日 (3/1) に収まる 2 件。JST に読み替えると 3/1 11:00 と 3/2 05:00 で日がまたがる
    await insertAt({
      tenantId: a.tenantId,
      agentId: a.agent.id,
      createdAt: '2026-03-01T02:00:00Z',
      inputTokens: 1,
      outputTokens: 2,
      costMicroUsd: 10n,
    });
    await insertAt({
      tenantId: a.tenantId,
      agentId: a.agent.id,
      createdAt: '2026-03-01T20:00:00Z',
      inputTokens: 3,
      outputTokens: 4,
      costMicroUsd: 20n,
    });
    // 接続のタイムゾーンを東京にしたクライアントを別に作る (DSN の options で接続時に指定する)
    const dsn = new URL(process.env.DATABASE_URL ?? '');
    dsn.searchParams.set('options', '-c timezone=Asia/Tokyo');
    // createPrismaClient() は環境変数から接続文字列を読むので、生成のあいだだけ差し替える
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = dsn.toString();
    const { createPrismaClient } = await import('@/lib/prisma-client');
    const { createPrismaRepos } = await import('@/data/adapters/prisma');
    const shifted = createPrismaClient();
    process.env.DATABASE_URL = original;
    // 後始末を確実にしたうえで集計する
    try {
      // 指定が実際に効いていることを先に確かめる (効いていなければこの検査は何も見ていない)
      const [{ timezone }] = await shifted.$queryRaw<
        { timezone: string }[]
      >`SELECT current_setting('TimeZone') AS "timezone"`;
      expect(timezone, 'セッションのタイムゾーンを変更できていない').toBe('Asia/Tokyo');
      // 東京のセッションで 3/1 の 1 日ぶんを集計する
      const totals = await createPrismaRepos(shifted).usageEvents.dailyTotals(a.tenantId, {
        start: new Date('2026-03-01T00:00:00Z'),
        endExclusive: new Date('2026-03-02T00:00:00Z'),
      });
      // UTC の日で切れているので 3/1 の 1 行にまとまる (現地時刻で切ると 3/1 と 3/2 の 2 行になる)
      expect(totals).toEqual([
        { day: '2026-03-01', requests: 2, inputTokens: 4, outputTokens: 6, costMicroUsd: 30n },
      ] satisfies DailyUsageTotal[]);
    } finally {
      // 余分な接続を残さない
      await shifted.$disconnect();
    }
  });

  it('エージェントで絞れる (同テナントの別エージェントは入らない)', async () => {
    // 同テナントに 2 つのエージェント
    const a = await makeTenantWithAgent(repos, 'A');
    const other = await repos.agents.create({
      tenantId: a.tenantId,
      name: 'bot-2',
      description: null,
      provider: Provider.anthropic,
      model: MODEL,
      budgetMicroUsd: null,
    });
    // それぞれ 1 件ずつ
    await insertAt({
      tenantId: a.tenantId,
      agentId: a.agent.id,
      createdAt: '2026-03-01T10:00:00Z',
      inputTokens: 1,
      outputTokens: 1,
      costMicroUsd: 1n,
    });
    await insertAt({
      tenantId: a.tenantId,
      agentId: other.id,
      createdAt: '2026-03-01T11:00:00Z',
      inputTokens: 2,
      outputTokens: 2,
      costMicroUsd: 2n,
    });
    // 片方だけを集計する
    const totals = await repos.usageEvents.dailyTotals(a.tenantId, {
      start: new Date('2026-03-01T00:00:00Z'),
      endExclusive: new Date('2026-03-02T00:00:00Z'),
      agentId: other.id,
    });
    // 指定したエージェントの 1 件だけ
    expect(totals).toEqual([
      { day: '2026-03-01', requests: 1, inputTokens: 2, outputTokens: 2, costMicroUsd: 2n },
    ]);
  });

  it('BIGINT の料金を桁を落とさず合計する (JavaScript の数値では表せない額)', async () => {
    // 安全な整数の範囲を超える合計になる 2 行
    const a = await makeTenantWithAgent(repos, 'A');
    const half = 9_007_199_254_740_993n;
    await insertAt({
      tenantId: a.tenantId,
      agentId: a.agent.id,
      createdAt: '2026-03-01T01:00:00Z',
      inputTokens: 1,
      outputTokens: 1,
      costMicroUsd: half,
    });
    await insertAt({
      tenantId: a.tenantId,
      agentId: a.agent.id,
      createdAt: '2026-03-01T02:00:00Z',
      inputTokens: 1,
      outputTokens: 1,
      costMicroUsd: half,
    });
    // 集計する
    const totals = await repos.usageEvents.dailyTotals(a.tenantId, {
      start: new Date('2026-03-01T00:00:00Z'),
      endExclusive: new Date('2026-03-02T00:00:00Z'),
    });
    // BigInt のまま正確に足される (number へ落とすとここで丸められる)
    expect(totals[0].costMicroUsd).toBe(half * 2n);
  });

  it('期間外の行は含まない (半開区間の境目)', async () => {
    // 期間の直前・直後
    const a = await makeTenantWithAgent(repos, 'A');
    await insertAt({
      tenantId: a.tenantId,
      agentId: a.agent.id,
      createdAt: '2026-02-28T23:59:59.999Z',
      inputTokens: 1,
      outputTokens: 1,
      costMicroUsd: 1n,
    });
    await insertAt({
      tenantId: a.tenantId,
      agentId: a.agent.id,
      createdAt: '2026-03-02T00:00:00Z',
      inputTokens: 1,
      outputTokens: 1,
      costMicroUsd: 1n,
    });
    // 3 月 1 日だけを集計する
    const totals = await repos.usageEvents.dailyTotals(a.tenantId, {
      start: new Date('2026-03-01T00:00:00Z'),
      endExclusive: new Date('2026-03-02T00:00:00Z'),
    });
    // 1 件も入らない
    expect(totals).toEqual([]);
  });
});
