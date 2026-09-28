// 日次集計 (GET /api/v1/usage/daily) の API テスト。
// ここで固定するのは「テナント境界」「UTC の日境界」「期間の指定の扱い」の 3 つ。
// 実 DB での集計 (SQL) が memory と同じ結果になることは契約テストが固定する
import { describe, expect, it } from 'vitest';
import { GET as getDailyUsage } from '@/app/api/v1/usage/daily/route';
import type { UsageEventRecord } from '@/data';
import { Provider, Role } from '@/domain/types';
import { USAGE_RANGE_MAX_DAYS } from '@/lib/constants';
import { call, seedEachTest } from './helpers';

// seed (2 テナント × 3 役割 + 既存エージェント)
const seed = seedEachTest();

// 応答の型 (OpenAPI の DailyUsageList)
interface DailyUsageListJson {
  items: {
    day: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    costMicroUsd: string;
  }[];
}

// 指定した日時の利用イベントを 1 行入れる (時刻を固定したいので表へ直接入れる)
function addEvent(options: {
  tenantId: string;
  agentId: string;
  createdAt: string;
  inputTokens?: number;
  outputTokens?: number;
  costMicroUsd?: bigint;
}): UsageEventRecord {
  // 行を組み立てる
  const row: UsageEventRecord = {
    id: seed.store.nextId('usage'),
    tenantId: options.tenantId,
    agentId: options.agentId,
    provider: Provider.anthropic,
    model: 'claude-sonnet-4-6',
    inputTokens: options.inputTokens ?? 100,
    outputTokens: options.outputTokens ?? 200,
    costMicroUsd: options.costMicroUsd ?? 1_000n,
    latencyMs: 10,
    statusCode: 200,
    createdAt: new Date(options.createdAt),
  };
  // 表へ入れる
  seed.store.usageEvents.set(row.id, row);
  return row;
}

// 集計を呼ぶ (既定は admin のトークン)
async function fetchDaily(query: string, token = seed.a.tokens.admin) {
  // クエリ付きで呼ぶ
  return call(getDailyUsage, { token, query });
}

describe('日次集計の結果', () => {
  it('期間内のイベントを UTC の日ごとに合計する', async () => {
    // 同じ日に 2 件、翌日に 1 件
    addEvent({
      tenantId: seed.a.id,
      agentId: seed.a.agent.id,
      createdAt: '2026-03-01T01:00:00Z',
      inputTokens: 10,
      outputTokens: 20,
      costMicroUsd: 500n,
    });
    addEvent({
      tenantId: seed.a.id,
      agentId: seed.a.agent.id,
      createdAt: '2026-03-01T23:00:00Z',
      inputTokens: 5,
      outputTokens: 7,
      costMicroUsd: 250n,
    });
    addEvent({
      tenantId: seed.a.id,
      agentId: seed.a.agent.id,
      createdAt: '2026-03-02T00:30:00Z',
      inputTokens: 1,
      outputTokens: 2,
      costMicroUsd: 100n,
    });
    // 2 日分を集計する
    const result = await fetchDaily('from=2026-03-01&to=2026-03-02');
    // 200 で 2 日分
    expect(result.status).toBe(200);
    const items = (result.json as DailyUsageListJson).items;
    expect(items).toHaveLength(2);
    // 1 日目は 2 件の合計
    expect(items[0]).toEqual({
      day: '2026-03-01',
      requests: 2,
      inputTokens: 15,
      outputTokens: 27,
      costMicroUsd: '750',
    });
    // 2 日目
    expect(items[1].day).toBe('2026-03-02');
    expect(items[1].requests).toBe(1);
  });

  it('日の境目は UTC (23:59Z と 00:00Z は別の日になる)', async () => {
    // 日付をまたぐ 2 件
    addEvent({
      tenantId: seed.a.id,
      agentId: seed.a.agent.id,
      createdAt: '2026-03-01T23:59:59.999Z',
    });
    addEvent({ tenantId: seed.a.id, agentId: seed.a.agent.id, createdAt: '2026-03-02T00:00:00Z' });
    // 2 日分を集計する
    const items = ((await fetchDaily('from=2026-03-01&to=2026-03-02')).json as DailyUsageListJson)
      .items;
    // 別の日として 1 件ずつ
    expect(items.map((item) => [item.day, item.requests])).toEqual([
      ['2026-03-01', 1],
      ['2026-03-02', 1],
    ]);
  });

  it('期間の開始日と終了日はどちらも含む', async () => {
    // 開始日の 0 時ちょうどと終了日の 23:59
    addEvent({ tenantId: seed.a.id, agentId: seed.a.agent.id, createdAt: '2026-03-01T00:00:00Z' });
    addEvent({ tenantId: seed.a.id, agentId: seed.a.agent.id, createdAt: '2026-03-03T23:59:59Z' });
    // 期間外 (前日と翌日)
    addEvent({ tenantId: seed.a.id, agentId: seed.a.agent.id, createdAt: '2026-02-28T23:59:59Z' });
    addEvent({ tenantId: seed.a.id, agentId: seed.a.agent.id, createdAt: '2026-03-04T00:00:00Z' });
    // 3 日分を集計する
    const items = ((await fetchDaily('from=2026-03-01&to=2026-03-03')).json as DailyUsageListJson)
      .items;
    // 端の 2 件だけが入る (期間外は入らない)
    expect(items.map((item) => item.day)).toEqual(['2026-03-01', '2026-03-03']);
  });

  it('イベントが無い日は行が出ない', async () => {
    // 1 件だけ
    addEvent({ tenantId: seed.a.id, agentId: seed.a.agent.id, createdAt: '2026-03-02T12:00:00Z' });
    // 3 日分を集計する
    const items = ((await fetchDaily('from=2026-03-01&to=2026-03-03')).json as DailyUsageListJson)
      .items;
    // 行はイベントのある日だけ
    expect(items).toHaveLength(1);
    expect(items[0].day).toBe('2026-03-02');
  });

  it('他テナントのイベントは含まれない', async () => {
    // 自テナントに 1 件、他テナントに 1 件
    addEvent({ tenantId: seed.a.id, agentId: seed.a.agent.id, createdAt: '2026-03-01T10:00:00Z' });
    addEvent({ tenantId: seed.b.id, agentId: seed.b.agent.id, createdAt: '2026-03-01T10:00:00Z' });
    // テナント A のトークンで集計する
    const items = ((await fetchDaily('from=2026-03-01&to=2026-03-01')).json as DailyUsageListJson)
      .items;
    // 自テナントの 1 件だけ
    expect(items[0].requests).toBe(1);
  });

  it('agentId で絞れる', async () => {
    // 同テナントに 2 つ目のエージェントを作る
    const other = await seed.repos.agents.create({
      tenantId: seed.a.id,
      name: '別のエージェント',
      description: null,
      provider: Provider.anthropic,
      model: 'claude-sonnet-4-6',
      budgetMicroUsd: null,
    });
    // それぞれ 1 件ずつ
    addEvent({ tenantId: seed.a.id, agentId: seed.a.agent.id, createdAt: '2026-03-01T10:00:00Z' });
    addEvent({ tenantId: seed.a.id, agentId: other.id, createdAt: '2026-03-01T11:00:00Z' });
    // 片方だけを集計する
    const items = (
      (await fetchDaily(`from=2026-03-01&to=2026-03-01&agentId=${other.id}`))
        .json as DailyUsageListJson
    ).items;
    // 指定したエージェントの 1 件だけ
    expect(items[0].requests).toBe(1);
  });

  it('viewer でも閲覧できる (view 権限)', async () => {
    // 1 件入れて viewer のトークンで呼ぶ
    addEvent({ tenantId: seed.a.id, agentId: seed.a.agent.id, createdAt: '2026-03-01T10:00:00Z' });
    const result = await fetchDaily('from=2026-03-01&to=2026-03-01', seed.a.tokens[Role.viewer]);
    // 200
    expect(result.status).toBe(200);
  });
});

describe('期間の指定', () => {
  it.each([
    ['from が無い', 'to=2026-03-01'],
    ['to が無い', 'from=2026-03-01'],
    ['どちらも無い', ''],
  ])('%s と 422 (無指定の全期間は許さない)', async (_label, query) => {
    // 期間は必須
    expect((await fetchDaily(query)).status).toBe(422);
  });

  it.each([
    ['形が違う', 'from=2026-3-1&to=2026-03-01'],
    ['日時になっている', 'from=2026-03-01T00:00:00Z&to=2026-03-01'],
    ['存在しない日 (2 月 30 日)', 'from=2026-02-30&to=2026-03-01'],
  ])('%s 日付は 422 (黙って別の日にしない)', async (_label, query) => {
    // 読めない日付は拒否する
    expect((await fetchDaily(query)).status).toBe(422);
  });

  it('from が to より後なら 422 (黙って空の結果を返さない)', async () => {
    // 逆順の指定
    expect((await fetchDaily('from=2026-03-05&to=2026-03-01')).status).toBe(422);
  });

  it('期間が上限を超えたら 422', async () => {
    // 上限ちょうどの翌日まで指定する (開始日を含むので +1 日で超える)
    const start = new Date('2026-01-01T00:00:00Z');
    const end = new Date(start.getTime() + USAGE_RANGE_MAX_DAYS * 24 * 60 * 60 * 1000);
    // 'YYYY-MM-DD' にする
    const toText = end.toISOString().slice(0, 10);
    // 上限 + 1 日なので拒否される
    expect((await fetchDaily(`from=2026-01-01&to=${toText}`)).status).toBe(422);
  });

  it('期間が上限ちょうどなら通る (境界値)', async () => {
    // 上限ちょうど (開始日を含めて USAGE_RANGE_MAX_DAYS 日)
    const start = new Date('2026-01-01T00:00:00Z');
    const end = new Date(start.getTime() + (USAGE_RANGE_MAX_DAYS - 1) * 24 * 60 * 60 * 1000);
    const toText = end.toISOString().slice(0, 10);
    // 200
    expect((await fetchDaily(`from=2026-01-01&to=${toText}`)).status).toBe(200);
  });

  it('agentId の形が不正なら 422 (DB へ渡さない)', async () => {
    // 資源 id の形でない値
    expect((await fetchDaily('from=2026-03-01&to=2026-03-01&agentId=a/b')).status).toBe(422);
  });
});
