// prisma 側では DB の制約・トリガが守っている規律を、memory 側でも固定する。
//
// **これが無いと ADR-0006 の構造的な死角が開く。** API テストは memory アダプタで走るので、
// memory が prisma より緩いと「API テストは緑、契約テストも緑、本番だけ違う挙動」になる。
// とくに監査ログは prisma 側では DB のトリガが追記専用を強制しているが、memory 側には
// トリガが無いので、同じ規律を Port の形 (更新・削除のメソッドを持たない) と
// この検査で保つ必要がある。
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryRepos, MemoryStore } from '@/data/adapters/memory';
import type { Repositories } from '@/data/ports';
import { auditRowHash, verifyAuditChain, type StoredAuditRow } from '@/domain/audit/chain';
import { AgentStatus, IncidentStatus, Provider, RuleAction, RuleKind } from '@/domain/types';
import { secretsEqual } from '@/lib/tokens';

// 監査ログのハッシュ計算に使う鍵 (検査用の固定値)
const SECRET = 'memory-test-audit-secret-0123456789ab';
// 連鎖を読むときの上限
const CHAIN_LIMIT = 1_000;
// ルール数の上限 (この検査では上限そのものは主題でないので十分大きい値を渡す)
const RULES_MAX = 50;

describe('memory アダプタ: ガードレールと監査ログ', () => {
  // 表とリポジトリ (テストごとに作り直す)
  let store: MemoryStore;
  let repos: Repositories;
  // テナントとエージェントの id
  let tenantId: string;
  let agentId: string;

  beforeEach(async () => {
    // 新しい表で組み立てる
    store = new MemoryStore();
    repos = createMemoryRepos(store);
    // テナントを作る
    const created = await repos.tenants.createWithAdmin({
      name: 'テナント',
      admin: { email: 'admin@example.com', name: '管理者' },
      token: {
        prefix: 'aop_u_test',
        tokenHash: 'hash',
        name: '初期',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    tenantId = created.tenant.id;
    // そのテナントのエージェント
    const agent = await repos.agents.create({
      tenantId,
      name: 'bot',
      description: null,
      provider: Provider.anthropic,
      model: 'claude-sonnet-4-6',
      budgetMicroUsd: null,
    });
    agentId = agent.id;
  });

  // ルールを 1 件作る (失敗したらテストを止める)
  async function makeRule(kind: RuleKind, action: RuleAction, forAgent: boolean) {
    // 作成する
    const created = await repos.guardrailRules.create(
      {
        tenantId,
        agentId: forAgent ? agentId : null,
        kind,
        threshold: kind === RuleKind.cost ? 1_000 : 0.5,
        windowMinutes: 60,
        action,
      },
      RULES_MAX,
    );
    // 作れていなければ続けられない
    if (created.status !== 'created')
      throw new Error(`ルールを作れませんでした: ${created.status}`);
    return created.rule;
  }

  // 監査ログを 1 行追記する
  async function appendAudit(action: string) {
    // 記録日時はアプリ側が決める
    const createdAt = new Date();
    // 追記する
    return repos.auditLogs.append(
      {
        tenantId,
        actorId: null,
        action,
        targetType: 'Agent',
        targetId: agentId,
        payload: null,
        createdAt,
      },
      ({ seq, prevHash, id }) =>
        auditRowHash(SECRET, {
          id,
          tenantId,
          seq,
          actorId: null,
          action,
          targetType: 'Agent',
          targetId: agentId,
          payload: null,
          createdAt,
          prevHash,
        }),
    );
  }

  it('他テナントのエージェントを指すルールは作れない (prisma の複合 FK と同じ)', async () => {
    // 2 つ目のテナントとそのエージェント
    const other = await repos.tenants.createWithAdmin({
      name: 'ほか',
      admin: { email: 'b@example.com', name: 'B' },
      token: {
        prefix: 'aop_u_test',
        tokenHash: 'hash-b',
        name: '初期',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const otherAgent = await repos.agents.create({
      tenantId: other.tenant.id,
      name: 'bot-b',
      description: null,
      provider: Provider.anthropic,
      model: 'claude-sonnet-4-6',
      budgetMicroUsd: null,
    });
    // 自テナントのルールが他テナントのエージェントを指そうとする
    const result = await repos.guardrailRules.create(
      {
        tenantId,
        agentId: otherAgent.id,
        kind: RuleKind.cost,
        threshold: 1_000,
        windowMinutes: 60,
        action: RuleAction.stop,
      },
      RULES_MAX,
    );
    // 拒否される
    expect(result.status).toBe('agent_not_found');
  });

  it('ルール数の上限を超えて作れない', async () => {
    // 上限 1 件で 1 件目は通る
    await makeRule(RuleKind.cost, RuleAction.notify, false);
    // 2 件目は上限に達している
    const second = await repos.guardrailRules.create(
      {
        tenantId,
        agentId: null,
        kind: RuleKind.quality,
        threshold: 0.7,
        windowMinutes: 60,
        action: RuleAction.notify,
      },
      1,
    );
    expect(second.status).toBe('too_many_rules');
  });

  it('有効なルールの取得はエージェント指定とテナント全体の和集合になる', async () => {
    // エージェント指定のルールとテナント全体のルール
    const forAgent = await makeRule(RuleKind.cost, RuleAction.stop, true);
    const forTenant = await makeRule(RuleKind.error_rate, RuleAction.notify, false);
    // 無効化したルールは含まれない
    const disabled = await makeRule(RuleKind.quality, RuleAction.notify, true);
    store.guardrailRules.set(disabled.id, { ...disabled, enabled: false });
    // 取得する
    const active = await repos.guardrailRules.findActiveRules(tenantId, { agentId });
    // 有効な 2 件だけが返る
    expect(active.map((rule) => rule.id).sort()).toEqual([forAgent.id, forTenant.id].sort());
  });

  it('種別で絞れる (起点によって見る種別が違う)', async () => {
    // 3 種別のルールを作る
    const cost = await makeRule(RuleKind.cost, RuleAction.stop, true);
    await makeRule(RuleKind.error_rate, RuleAction.notify, true);
    await makeRule(RuleKind.quality, RuleAction.notify, true);
    // コストだけを引く
    const active = await repos.guardrailRules.findActiveRules(tenantId, {
      agentId,
      kinds: [RuleKind.cost],
    });
    // 1 件だけ返る
    expect(active.map((rule) => rule.id)).toEqual([cost.id]);
  });

  it('インシデントを持つルールは消せない (prisma の Restrict と同じ)', async () => {
    // ルールを作って発火させる
    const rule = await makeRule(RuleKind.cost, RuleAction.notify, true);
    await repos.incidents.raise({
      tenantId,
      agentId,
      ruleId: rule.id,
      summary: '発火',
      suspendAgent: false,
    });
    // 消せない
    expect(await repos.guardrailRules.delete(tenantId, rule.id)).toBe('restricted');
  });

  it('発火は記録と停止を同時に行い、手動停止は塗り替えない', async () => {
    // stop のルール
    const rule = await makeRule(RuleKind.cost, RuleAction.stop, true);
    // 1 回目: 稼働中なので停止する
    const first = await repos.incidents.raise({
      tenantId,
      agentId,
      ruleId: rule.id,
      summary: '発火',
      suspendAgent: true,
    });
    expect(first?.suspended).toBe(true);
    expect((await repos.agents.findById(tenantId, agentId))?.status).toBe(AgentStatus.suspended);
    // 2 回目: 既に suspended なので状態を変えない
    const second = await repos.incidents.raise({
      tenantId,
      agentId,
      ruleId: rule.id,
      summary: '発火',
      suspendAgent: true,
    });
    expect(second?.suspended).toBe(false);
  });

  it('インシデントの解決は 1 度だけ成功する (prisma の条件付き更新と同じ)', async () => {
    // 発火させる
    const rule = await makeRule(RuleKind.cost, RuleAction.notify, true);
    const raised = await repos.incidents.raise({
      tenantId,
      agentId,
      ruleId: rule.id,
      summary: '発火',
      suspendAgent: false,
    });
    if (!raised) throw new Error('発火できませんでした');
    // 1 回目は解決、2 回目は既に解決済み
    expect(await repos.incidents.resolve(tenantId, raised.incident.id)).toBe('resolved');
    expect(await repos.incidents.resolve(tenantId, raised.incident.id)).toBe('already_resolved');
    // 状態と解決日時が入っている
    const resolved = await repos.incidents.findById(tenantId, raised.incident.id);
    expect(resolved?.status).toBe(IncidentStatus.resolved);
    expect(resolved?.resolvedAt).not.toBeNull();
  });

  it('監査ログは連番と連鎖が繋がり、検証が通る', async () => {
    // 3 行追記する
    const first = await appendAudit('a1');
    const second = await appendAudit('a2');
    const third = await appendAudit('a3');
    // 連番は 1 から 1 ずつ
    expect([first.seq, second.seq, third.seq]).toEqual([1n, 2n, 3n]);
    // 連鎖が繋がっている
    expect(first.prevHash).toBeNull();
    expect(second.prevHash).toBe(first.hash);
    expect(third.prevHash).toBe(second.hash);
    // 検証が通る
    const { rows } = await repos.auditLogs.readChain(tenantId, CHAIN_LIMIT);
    expect(verifyAuditChain(SECRET, tenantId, rows as StoredAuditRow[], secretsEqual)).toEqual({
      ok: true,
      verified: 3,
    });
  });

  it('表を直接書き換えると連鎖の検証が落ちる (prisma 側でトリガを外した場合と同じ結果)', async () => {
    // 3 行追記する
    await appendAudit('a1');
    const second = await appendAudit('a2');
    await appendAudit('a3');
    // **表へ直接当てる** — Port には更新のメソッドが無いので、prisma 側でトリガを外すのと同じ立場
    const stored = store.auditLogs.get(second.id);
    if (!stored) throw new Error('行が見つかりません');
    store.auditLogs.set(second.id, { ...stored, action: 'tampered' });
    // 検証は 2 行目で落ちる
    const { rows } = await repos.auditLogs.readChain(tenantId, CHAIN_LIMIT);
    expect(verifyAuditChain(SECRET, tenantId, rows as StoredAuditRow[], secretsEqual)).toEqual({
      ok: false,
      verified: 1,
      brokenSeq: 2n,
      reason: 'hash_mismatch',
    });
  });

  it('連鎖の読み出しは上限に達したことを伝える', async () => {
    // 3 行追記する
    await appendAudit('a1');
    await appendAudit('a2');
    await appendAudit('a3');
    // 上限 2 件で読む
    const limited = await repos.auditLogs.readChain(tenantId, 2);
    // 2 件だけ返り、続きがあることが分かる
    expect(limited.rows).toHaveLength(2);
    expect(limited.reachedLimit).toBe(true);
    // 上限に届かない読み出しでは false
    const all = await repos.auditLogs.readChain(tenantId, CHAIN_LIMIT);
    expect(all.reachedLimit).toBe(false);
  });

  it('窓の集計は失敗の下限 (400 以上) で分子を数える', async () => {
    // 境界をまたぐステータスで記録する (399 は成功、400 は失敗)
    for (const statusCode of [200, 399, 400, 503]) {
      await repos.usageEvents.record({
        tenantId,
        agentId,
        provider: Provider.anthropic,
        model: 'claude-sonnet-4-6',
        inputTokens: 1,
        outputTokens: 1,
        costMicroUsd: 100n,
        latencyMs: 1,
        statusCode,
      });
    }
    // 十分広い窓で集計する
    const totals = await repos.usageEvents.windowTotals(tenantId, {
      start: new Date(Date.now() - 3_600_000),
      endExclusive: new Date(Date.now() + 60_000),
    });
    // 4 件のうち 400 以上の 2 件が失敗
    expect(totals).toEqual({ requests: 4, errorRequests: 2, costMicroUsd: 400n });
  });
});
