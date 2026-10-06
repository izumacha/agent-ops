// **受け入れ基準 3「表示データと DB 集計の突合テスト一致 100%」**（Step5 / docs/roadmap.md）。
//
// 画面・CSV・ここがすべて `loadDashboardSummary` を通るので、この 1 本が「画面に出る数値」を
// 突き合わせていることになる。
//
// **ゲート（`scripts/gate-step5.mjs`）はテスト名に `突合: 表示データと DB 集計が一致する` を
// 含む pass したテストを探す**（名前は `scripts/lib/step5-criteria.mjs` が正本）。名前を変える
// ときはそちらも直すこと — 一致しなくなると受け入れ基準 3 を誰も確かめないまま緑になる。
//
// **期待値を同じ関数で作らない。** `loadDashboardSummary` の出力どうしを比べると、集計が
// 間違っていても両辺が同じだけ間違って緑になる。ここでは**テストが投入した行から独立に
// 数え直した値**と比べる（分母・分子・合計を 1 件ずつ足す素朴な実装をテスト側に置く）。
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryRepos, MemoryStore } from '@/data/adapters/memory';
import type { Repositories, UsageEventRecord } from '@/data';
import { USAGE_ERROR_STATUS_FLOOR } from '@/domain/guardrail/rule';
import {
  EvaluationRunStatus,
  IncidentStatus,
  Provider,
  RuleAction,
  RuleKind,
} from '@/domain/types';
import type { UsageWindow } from '@/domain/usage-window';
import { formatUtcDay } from '@/domain/usage-window';
import { DASHBOARD_OPEN_INCIDENTS_MAX } from '@/lib/constants';
import { loadDashboardSummary } from '@/lib/dashboard/summary';
// エージェントを作るテスト用ヘルパー (上限は必須引数なので 1 か所にまとめる)
import { createTestAgent } from './lib/agent-limits';

// 検査に使うモデル名 (料金表にある値である必要はない。集計は料金を足すだけ)
const MODEL = 'claude-sonnet-4-6';

// 投入した利用イベントから「あるべき数値」を独立に数え直す。
// **`loadDashboardSummary` を 1 行も使わない**のが要点
function recountUsage(
  events: UsageEventRecord[],
  tenantId: string,
  window: UsageWindow,
): { requests: number; errorRequests: number; costMicroUsd: bigint; days: Set<string> } {
  // 期間内・同テナントの行だけを残す (半開区間)
  const inWindow = events.filter(
    (event) =>
      event.tenantId === tenantId &&
      event.createdAt >= window.start &&
      event.createdAt < window.endExclusive,
  );
  // 1 件ずつ素朴に数える
  let requests = 0;
  let errorRequests = 0;
  let costMicroUsd = 0n;
  const days = new Set<string>();
  for (const event of inWindow) {
    requests += 1;
    if (event.statusCode >= USAGE_ERROR_STATUS_FLOOR) errorRequests += 1;
    costMicroUsd += event.costMicroUsd;
    days.add(formatUtcDay(event.createdAt));
  }
  return { requests, errorRequests, costMicroUsd, days };
}

describe('ダッシュボードの数値と DB 集計の突合', () => {
  // 表とリポジトリ (テストごとに作り直す)
  let store: MemoryStore;
  let repos: Repositories;
  // テナント 2 つ (境界の検査に使う) とエージェント
  let tenantId: string;
  let otherTenantId: string;
  let agentId: string;
  // 投入した利用イベント (期待値を数え直すための記録)
  let events: UsageEventRecord[];

  // 期間は 3 日ぶん (日をまたぐ・端の時刻を含める)
  const window: UsageWindow = {
    start: new Date('2026-05-01T00:00:00Z'),
    endExclusive: new Date('2026-05-04T00:00:00Z'),
    days: 3,
  };

  // 利用イベントを 1 件入れて記録する (時刻を固定したいので表へ直接入れる)
  function addEvent(options: {
    tenantId: string;
    agentId: string;
    createdAt: string;
    costMicroUsd: bigint;
    statusCode?: number;
  }): void {
    const id = store.nextId('usage');
    const row: UsageEventRecord = {
      id,
      tenantId: options.tenantId,
      agentId: options.agentId,
      provider: Provider.anthropic,
      model: MODEL,
      inputTokens: 1,
      outputTokens: 2,
      costMicroUsd: options.costMicroUsd,
      latencyMs: 3,
      statusCode: options.statusCode ?? 200,
      createdAt: new Date(options.createdAt),
    };
    store.usageEvents.set(id, row);
    events.push(row);
  }

  beforeEach(async () => {
    // 新しい表で組み立てる
    store = new MemoryStore();
    repos = createMemoryRepos(store);
    events = [];
    // テナントを 2 つ作る (片方は「混ざらないこと」の確認用)
    const main = await repos.tenants.createWithAdmin({
      name: 'テナント',
      admin: { email: 'admin@example.com', name: '管理者' },
      token: {
        prefix: 'aop_u_main',
        tokenHash: 'hash-main',
        name: '初期',
        expiresAt: new Date('2027-01-01T00:00:00Z'),
      },
    });
    tenantId = main.tenant.id;
    const other = await repos.tenants.createWithAdmin({
      name: '別テナント',
      admin: { email: 'admin@other.example.com', name: '管理者' },
      token: {
        prefix: 'aop_u_other',
        tokenHash: 'hash-other',
        name: '初期',
        expiresAt: new Date('2027-01-01T00:00:00Z'),
      },
    });
    otherTenantId = other.tenant.id;
    // 主テナントのエージェント
    const agent = await createTestAgent(repos, {
      tenantId,
      name: 'bot',
      description: null,
      provider: Provider.anthropic,
      model: MODEL,
      budgetMicroUsd: null,
    });
    agentId = agent.id;
  });

  it('突合: 表示データと DB 集計が一致する（回数・失敗件数・料金・日数を独立に数え直す）', async () => {
    // 期間内に成功 3 件と失敗 2 件、期間外に 1 件ずつ入れる
    addEvent({ tenantId, agentId, createdAt: '2026-05-01T00:00:00Z', costMicroUsd: 10n });
    addEvent({ tenantId, agentId, createdAt: '2026-05-01T23:59:59.999Z', costMicroUsd: 20n });
    addEvent({ tenantId, agentId, createdAt: '2026-05-02T12:00:00Z', costMicroUsd: 30n });
    addEvent({
      tenantId,
      agentId,
      createdAt: '2026-05-02T13:00:00Z',
      costMicroUsd: 0n,
      statusCode: 500,
    });
    addEvent({
      tenantId,
      agentId,
      createdAt: '2026-05-03T01:00:00Z',
      costMicroUsd: 0n,
      statusCode: 429,
    });
    // 期間の手前と後ろ (入ってはいけない)
    addEvent({ tenantId, agentId, createdAt: '2026-04-30T23:59:59.999Z', costMicroUsd: 999n });
    addEvent({ tenantId, agentId, createdAt: '2026-05-04T00:00:00Z', costMicroUsd: 999n });
    // 画面が使う数値を取る
    const summary = await loadDashboardSummary(repos, tenantId, window);
    // テスト側で独立に数え直す
    const expected = recountUsage(events, tenantId, window);
    // 分母・分子・料金が一致する
    expect(summary.requests).toBe(expected.requests);
    expect(summary.errorRequests).toBe(expected.errorRequests);
    expect(summary.costMicroUsd).toBe(expected.costMicroUsd);
    // 日次の明細は「イベントがあった日の数」だけ行がある (無い日は行を作らない)
    expect(summary.daily).toHaveLength(expected.days.size);
    // 明細の合計も全体の合計に一致する (表とカードが別のことを言わない)
    expect(summary.daily.reduce((total, row) => total + row.requests, 0)).toBe(expected.requests);
    expect(summary.daily.reduce((total, row) => total + row.costMicroUsd, 0n)).toBe(
      expected.costMicroUsd,
    );
    // 稼働率は (分母 - 分子) / 分母
    expect(summary.uptimeRate).toBe(
      (expected.requests - expected.errorRequests) / expected.requests,
    );
  });

  it('別テナントの行は 1 つも混ざらない', async () => {
    // 主テナントに 1 件、別テナントに 3 件入れる
    const otherAgent = await createTestAgent(repos, {
      tenantId: otherTenantId,
      name: 'bot-other',
      description: null,
      provider: Provider.anthropic,
      model: MODEL,
      budgetMicroUsd: null,
    });
    addEvent({ tenantId, agentId, createdAt: '2026-05-01T10:00:00Z', costMicroUsd: 5n });
    for (const hour of ['11', '12', '13']) {
      addEvent({
        tenantId: otherTenantId,
        agentId: otherAgent.id,
        createdAt: `2026-05-01T${hour}:00:00Z`,
        costMicroUsd: 100n,
      });
    }
    // 主テナントの数値を取る
    const summary = await loadDashboardSummary(repos, tenantId, window);
    // 独立に数え直した主テナントの値と一致する (別テナントの 3 件・300 は入らない)
    const expected = recountUsage(events, tenantId, window);
    expect(summary.requests).toBe(expected.requests);
    expect(summary.requests).toBe(1);
    expect(summary.costMicroUsd).toBe(5n);
  });

  it('呼び出しが 0 件の期間は稼働率を null にする (0% と表示しない)', async () => {
    // 1 件も入れずに取る
    const summary = await loadDashboardSummary(repos, tenantId, window);
    // 分母も分子も 0 で、稼働率は「測れない」
    expect(summary.requests).toBe(0);
    expect(summary.errorRequests).toBe(0);
    expect(summary.uptimeRate).toBeNull();
    // 明細も空 (無い日の行を作らない)
    expect(summary.daily).toEqual([]);
  });

  it('品質は期間内の最新の採点が成立した実行から読む', async () => {
    // 評価セットを作る (実行はセットに紐づく)
    const created = await repos.evaluations.createSet({
      tenantId,
      name: 'セット',
      cases: [{ input: '質問', expected: '答え' }],
    });
    // 戻りは { set, cases } なので id は set から取る
    const setId = created.set.id;
    // 期間内に 2 件 (新しいほうが読まれる) と、期間外に 1 件入れる
    const runs = [
      { createdAt: '2026-05-01T09:00:00Z', accuracy: 0.9, safety: 0.9, deviation: 0.1 },
      { createdAt: '2026-05-03T09:00:00Z', accuracy: 0.8, safety: 0.7, deviation: 0.2 },
      { createdAt: '2026-05-05T09:00:00Z', accuracy: 0.1, safety: 0.1, deviation: 0.9 },
    ];
    for (const run of runs) {
      const saved = await repos.evaluations.createRun({
        tenantId,
        agentId,
        setId,
        accuracy: run.accuracy,
        safety: run.safety,
        deviation: run.deviation,
        status: EvaluationRunStatus.completed,
        scoredCases: 1,
        excludedCases: 0,
        judgeProvider: Provider.anthropic,
        judgeModel: MODEL,
        results: [],
      });
      // createdAt は表が決めるので、検査したい時刻へ書き換える
      const runId = saved!.run.id;
      const row = store.evaluationRuns.get(runId);
      store.evaluationRuns.set(runId, { ...row!, createdAt: new Date(run.createdAt) });
    }
    // 画面の数値を取る
    const summary = await loadDashboardSummary(repos, tenantId, window);
    // 期間内の新しいほう (5/3) が読まれる。期間外の 5/5 は入らない
    expect(summary.quality?.ranAt.toISOString()).toBe('2026-05-03T09:00:00.000Z');
    // 3 観点の最悪値 — 逸脱は向きが逆なので 1 - 0.2 = 0.8 に直してから最小を採る
    expect(summary.quality?.score).toBe(0.7);
    // どのエージェントの実行かも分かる (画面がリンクを張る)
    expect(summary.quality?.agentId).toBe(agentId);
  });

  it('採点が成立した実行が無ければ品質は null', async () => {
    // 評価を 1 度も走らせていない
    const summary = await loadDashboardSummary(repos, tenantId, window);
    // 「測れていない」を 0 点として表示しない
    expect(summary.quality).toBeNull();
  });

  it('未解決インシデントは上限まで数え、超えていれば旗を立てる', async () => {
    // ルールを 1 本作る (インシデントはルールに紐づく)
    const ruleResult = await repos.guardrailRules.create(
      {
        tenantId,
        // テナント全体のルール (インシデントは発火したエージェントごとに作られる)
        agentId: null,
        kind: RuleKind.cost,
        threshold: 1,
        windowMinutes: 60,
        action: RuleAction.notify,
      },
      { maxEnabled: 10, maxRows: 40 },
    );
    // 作成できたことを確かめてから id を取る
    expect(ruleResult.status).toBe('created');
    const ruleId = ruleResult.status === 'created' ? ruleResult.rule.id : '';
    // 上限 + 1 件の未解決インシデントを作る。
    // **同じルール × 同じエージェントは 1 行しか作られない**ので、エージェントを分ける
    for (let index = 0; index <= DASHBOARD_OPEN_INCIDENTS_MAX; index += 1) {
      const agent = await createTestAgent(repos, {
        tenantId,
        name: `bot-${index}`,
        description: null,
        provider: Provider.anthropic,
        model: MODEL,
        budgetMicroUsd: null,
      });
      await repos.incidents.raise({
        tenantId,
        agentId: agent.id,
        ruleId,
        summary: `超過 ${index}`,
        suspendAgent: false,
      });
    }
    // 画面の数値を取る
    const summary = await loadDashboardSummary(repos, tenantId, window);
    // 数えるのは上限まで (無制限の取得をしない)
    expect(summary.openIncidents).toBe(DASHBOARD_OPEN_INCIDENTS_MAX);
    // 超えていることは旗で伝える (画面は「〜件以上」と表示できる)
    expect(summary.openIncidentsReachedLimit).toBe(true);
  });

  it('解決済みのインシデントは数えない', async () => {
    // ルールと 1 件のインシデントを作って解決する
    const ruleResult = await repos.guardrailRules.create(
      {
        tenantId,
        agentId: null,
        kind: RuleKind.error_rate,
        threshold: 0.5,
        windowMinutes: 60,
        action: RuleAction.notify,
      },
      { maxEnabled: 10, maxRows: 40 },
    );
    expect(ruleResult.status).toBe('created');
    const ruleId = ruleResult.status === 'created' ? ruleResult.rule.id : '';
    const raised = await repos.incidents.raise({
      tenantId,
      agentId,
      ruleId,
      summary: '超過',
      suspendAgent: false,
    });
    await repos.incidents.resolve(tenantId, raised!.incident.id);
    // 解決後は 0 件
    const summary = await loadDashboardSummary(repos, tenantId, window);
    expect(summary.openIncidents).toBe(0);
    expect(summary.openIncidentsReachedLimit).toBe(false);
    // 念のため、解決済みの行自体は残っている (数えないだけ)
    const all = await repos.incidents.list(tenantId, { limit: 10 });
    expect(all.items).toHaveLength(1);
    expect(all.items[0].status).toBe(IncidentStatus.resolved);
  });
});
