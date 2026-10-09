// 保守の定期実行（src/lib/maintenance/run.ts）の検査。
// memory アダプタで組み立てるので DB は要らない。**通知も上流も実際には呼ばない**
// （ルールを発火させる検査では通知の設定を外し、fail-open で飛ばす経路を通す）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRepos } from '@/data/adapters/memory';
import { MemoryStore } from '@/data/adapters/memory/store';
import type { Repositories } from '@/data/ports';
import { runMaintenance } from '@/lib/maintenance/run';
import { AUDIT_HMAC_SECRET_ENV } from '@/lib/audit/secret';
import { AgentStatus, Provider, RuleAction, RuleKind } from '@/domain/types';
import {
  MAINTENANCE_RATE_LIMIT_SWEEP_BATCH,
  MAINTENANCE_RATE_LIMIT_SWEEP_MAX_BATCHES,
  MAINTENANCE_TENANT_SCAN_MAX,
  RATE_LIMIT_WINDOW_MS,
} from '@/lib/constants';
import { RATE_LIMIT_TIER } from '@/lib/api/rate-limit';
import { createTestAgent } from './lib/agent-limits';

// 監査ログの鍵（下限を満たす固定値）
const AUDIT_SECRET = 'maintenance-test-audit-secret-01234567';
// エージェントが使うモデル名
const MODEL = 'claude-sonnet-4-6';

// 環境変数（監査の鍵だけ設定し、通知先は設定しない = 通知は fail-open で飛ぶ）
function env(): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', [AUDIT_HMAC_SECRET_ENV]: AUDIT_SECRET } as NodeJS.ProcessEnv;
}

describe('保守の定期実行', () => {
  // 表とリポジトリ（テストごとに作り直す）
  let store: MemoryStore;
  let repos: Repositories;

  beforeEach(() => {
    // 新しい表で組み立てる
    store = new MemoryStore();
    repos = createMemoryRepos(store);
    // 通知先の設定が無いことを知らせるログを黙らせる
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // テナントを 1 件作って id を返す
  async function makeTenant(name: string): Promise<string> {
    const created = await repos.tenants.createWithAdmin({
      name,
      admin: { email: `${name}@example.com`, name: '管理者' },
      token: {
        prefix: `aop_u_${name}`,
        tokenHash: `hash-${name}`,
        name: '初期',
        expiresAt: new Date('2099-01-01T00:00:00Z'),
      },
    });
    return created.tenant.id;
  }

  // エージェントを 1 件作って id を返す
  async function makeAgent(tenantId: string, name: string): Promise<string> {
    const agent = await createTestAgent(repos, {
      tenantId,
      name,
      description: null,
      provider: Provider.anthropic,
      model: MODEL,
      budgetMicroUsd: null,
    });
    return agent.id;
  }

  // 1 要求ぶん進める（既定の引数をまとめる）
  async function run(
    overrides: Partial<Parameters<typeof runMaintenance>[1]> = {},
  ): ReturnType<typeof runMaintenance> {
    return runMaintenance(repos, { agentBudget: 50, now: new Date(), ...overrides }, env());
  }

  /**
   * 表の時計を先へ進める（`MemoryStore.now` を差し替える）。
   *
   * **回収の境目は記録側の時計が決める**ので、要求の `now` を動かしても掃きは変わらない
   * （理由は Port の `sweep`）。「窓から外れた行」を作るにはこちらを動かす。
   * @param ms 進める量（ミリ秒）
   */
  function advanceStoreClock(ms: number): void {
    // いまの時刻を控える（差し替える前に読む）
    const shifted = new Date(store.now().getTime() + ms);
    // 以後はこの時刻を返す
    store.now = () => shifted;
  }

  // レート制限の記録を 1 件入れる（`consume` を通すと「いま」の行になる）
  async function recordRateLimitHit(key: string): Promise<void> {
    await repos.rateLimit.consume({
      key,
      tier: RATE_LIMIT_TIER.standard,
      windowMs: RATE_LIMIT_WINDOW_MS,
      sharedLimit: 1_000,
      extraLimit: null,
    });
  }

  describe('レート制限の記録の回収', () => {
    it('窓の中の記録は消さない（生きている枠をリセットしない）', async () => {
      // いまの記録を 1 件入れる（窓の中）
      await recordRateLimitHit('tenant:alive');
      // 一巡を始める
      const result = await run();
      // 1 件も消していない
      expect(result.rateLimitHitsDeleted).toBe(0);
      // 回収しきっている
      expect(result.rateLimitSweepComplete).toBe(true);
      // 記録はまだ数えられる（消えていない）
      expect(store.rateLimitHits.get('tenant:alive')?.length).toBe(1);
    });

    it('窓から外れた記録は消す（二度と来ないキーの行）', async () => {
      // いまの記録を 1 件入れる
      await recordRateLimitHit('tenant:gone');
      // **表の時計を窓の長さより先へ進める**（境目を決めるのは記録側なので、
      // 要求の `now` ではなくこちらを動かす。理由は Port の `sweep`）
      advanceStoreClock(RATE_LIMIT_WINDOW_MS * 2);
      const result = await run();
      // 消えている
      expect(result.rateLimitHitsDeleted).toBe(1);
      expect(result.rateLimitSweepComplete).toBe(true);
      // 表からも消えている（キーごと空になる）
      expect(store.rateLimitHits.get('tenant:gone')?.length ?? 0).toBe(0);
    });

    it('要求の時刻を先へずらしても消えない（境目は記録側の時計が決める）', async () => {
      // いまの記録を 1 件入れる
      await recordRateLimitHit('tenant:alive');
      // **アプリの時計が 10 分進んでいても**、表の時計は進んでいないので窓の中。
      // 境目を呼び出し側の時計で決めていた頃は、この行が消えて枠がリセットされた
      const result = await run({ now: new Date(Date.now() + RATE_LIMIT_WINDOW_MS * 10) });
      expect(result.rateLimitHitsDeleted).toBe(0);
      expect(store.rateLimitHits.get('tenant:alive')?.length).toBe(1);
    });

    it('一巡の途中（カーソルあり）では回収しない（同じ掃きを何十回も繰り返さない）', async () => {
      // 窓から外れる記録を 1 件入れる
      await recordRateLimitHit('tenant:gone');
      // テナントを 1 件作る（カーソルを作るため）
      const tenantId = await makeTenant('a');
      const tenant = await repos.tenants.findById(tenantId);
      if (tenant === null) throw new Error('テナントが見つかりません');
      // 表の時計を進めて、記録が窓から外れる状態にする
      advanceStoreClock(RATE_LIMIT_WINDOW_MS * 2);
      // カーソルを渡して続きから進める
      const result = await run({
        tenantCursor: { createdAt: tenant.createdAt, id: tenant.id },
      });
      // 回収は 1 件も行われていない
      expect(result.rateLimitHitsDeleted).toBe(0);
      // 記録は残っている
      expect(store.rateLimitHits.get('tenant:gone')?.length).toBe(1);
    });

    it('バッチ数の上限で打ち切ったら「まだ残っている」と返す', async () => {
      // 1 回のバッチで消す上限 × バッチ数の上限 + 1 件を、消せる位置に積む
      const total = MAINTENANCE_RATE_LIMIT_SWEEP_BATCH * MAINTENANCE_RATE_LIMIT_SWEEP_MAX_BATCHES;
      // 表へ直接入れる（`consume` を 1 万回通すより速く、行の形は同じ）。
      // **表の時計から見て窓の外**になる時刻を使う
      const old = new Date(store.now().getTime() - RATE_LIMIT_WINDOW_MS * 2);
      store.rateLimitHits.set(
        'tenant:many',
        Array.from({ length: total + 1 }, () => ({ tier: RATE_LIMIT_TIER.standard, at: old })),
      );
      // 一巡を始める
      const result = await run();
      // 上限ぶんだけ消し、打ち切ったことを返す
      expect(result.rateLimitHitsDeleted).toBe(total);
      expect(result.rateLimitSweepComplete).toBe(false);
      // 1 件だけ残っている（次の要求が続ける）
      expect(store.rateLimitHits.get('tenant:many')?.length).toBe(1);
    });

    it('打ち切ったときはテナントを 1 件も歩かず、旗で「まだ残っている」と伝える', async () => {
      // 判定できるエージェントを用意する（歩いてしまったら件数に現れる）
      const tenantId = await makeTenant('a');
      await makeAgent(tenantId, 'a1');
      // 回収が 1 要求で終わらないだけの行を、消せる位置に積む
      const total = MAINTENANCE_RATE_LIMIT_SWEEP_BATCH * MAINTENANCE_RATE_LIMIT_SWEEP_MAX_BATCHES;
      const old = new Date(store.now().getTime() - RATE_LIMIT_WINDOW_MS * 2);
      store.rateLimitHits.set(
        'tenant:many',
        Array.from({ length: total + 1 }, () => ({ tier: RATE_LIMIT_TIER.standard, at: old })),
      );
      // 一巡を始める
      const result = await run();
      // **テナントを 1 件も歩いていない**（回収を先に片付ける）
      expect(result.agentsEvaluated).toBe(0);
      // **「やることが残っている」が旗で伝わる**。カーソルは両方 null = 同じ呼び方をもう一度
      expect(result.passComplete).toBe(false);
      expect(result.nextTenantCursor).toBeNull();
      expect(result.nextAgentCursor).toBeNull();
      // 回収が途中であることも別の値で分かる
      expect(result.rateLimitSweepComplete).toBe(false);
    });

    it('回収が終われば同じ要求でそのまま判定へ進む', async () => {
      // 1 要求で回収しきれる件数だけ積む
      const tenantId = await makeTenant('a');
      await makeAgent(tenantId, 'a1');
      const old = new Date(store.now().getTime() - RATE_LIMIT_WINDOW_MS * 2);
      store.rateLimitHits.set('tenant:few', [{ tier: RATE_LIMIT_TIER.standard, at: old }]);
      // 一巡を始める
      const result = await run();
      // 回収も判定も同じ要求で済み、一巡が終わっている
      expect(result.rateLimitHitsDeleted).toBe(1);
      expect(result.rateLimitSweepComplete).toBe(true);
      expect(result.agentsEvaluated).toBe(1);
      expect(result.passComplete).toBe(true);
    });
  });

  describe('ガードレールの定期掃き', () => {
    it('稼働中のエージェントを持たないテナントも歩いた件数に数え、上限で打ち切る', async () => {
      // **エージェントの予算だけではループの脱出条件にならない。** 稼働中のエージェントが
      // 0 件のテナントは判定件数を増やさないので、上限が無いとテナント数ぶんのクエリを
      // 1 要求で流し、配備先の実行時間上限に当たって要求ごと落ちる（応答が返らないので
      // カーソルも受け取れず一巡が永久に終わらない）
      const tenants = [];
      for (const name of ['a', 'b', 'c']) tenants.push(await makeTenant(name));
      // 1 件目のエージェントだけ作り、止めておく（＝稼働中は 0 件）
      const stopped = await makeAgent(tenants[0], 'stopped');
      await repos.agents.setStatus(tenants[0], stopped, AgentStatus.suspended);
      // 一巡を始める（判定できるエージェントは 1 件も無い）
      const result = await run();
      // **3 件すべて歩いたことが応答に出る**（判定件数は 0）
      expect(result.tenantsVisited).toBe(3);
      expect(result.agentsEvaluated).toBe(0);
      // テナントが尽きたので一巡は終わっている
      expect(result.passComplete).toBe(true);
    });

    it('テナント側の上限に達したら続きのカーソルを返す（1 要求の長さを縛る）', async () => {
      // 上限より 1 件多いテナントを作る（どれも稼働中のエージェントは 0 件）
      for (let index = 0; index <= MAINTENANCE_TENANT_SCAN_MAX; index += 1) {
        await makeTenant(`t${index}`);
      }
      // 一巡を始める
      const result = await run();
      // **上限ぶんだけ歩いて止まる**（上限が無ければテナント数ぶん全部歩いてしまう）
      expect(result.tenantsVisited).toBe(MAINTENANCE_TENANT_SCAN_MAX);
      // まだ終わっていないので続きのカーソルが返る
      expect(result.passComplete).toBe(false);
      expect(result.nextTenantCursor).not.toBeNull();
    });

    it('テナントが 1 件も無ければ一巡はすぐ終わる', async () => {
      // 何も作らずに進める
      const result = await run();
      // 一巡が終わっている
      expect(result.passComplete).toBe(true);
      expect(result.nextTenantCursor).toBeNull();
      expect(result.nextAgentCursor).toBeNull();
      expect(result.agentsEvaluated).toBe(0);
    });

    it('全テナントの稼働中のエージェントを判定する', async () => {
      // 2 テナント × 2 エージェント
      const a = await makeTenant('a');
      const b = await makeTenant('b');
      await makeAgent(a, 'a1');
      await makeAgent(a, 'a2');
      await makeAgent(b, 'b1');
      await makeAgent(b, 'b2');
      // 一巡を始める
      const result = await run();
      // 4 件すべて判定し、一巡が終わっている
      expect(result.agentsEvaluated).toBe(4);
      expect(result.passComplete).toBe(true);
    });

    it('停止しているエージェントは判定しない（費用だけ掛かって効果が無い）', async () => {
      // 1 テナントに 2 件作り、1 件を止める
      const a = await makeTenant('a');
      const alive = await makeAgent(a, 'alive');
      const stopped = await makeAgent(a, 'stopped');
      await repos.agents.setStatus(a, stopped, AgentStatus.suspended);
      // 一巡を始める
      const result = await run();
      // 稼働中の 1 件だけ
      expect(result.agentsEvaluated).toBe(1);
      // 念のため、止めた側がまだ存在することも確かめる（絞り込みの取り違えを拾う）
      expect((await repos.agents.findById(a, alive))?.status).toBe(AgentStatus.active);
      expect((await repos.agents.findById(a, stopped))?.status).toBe(AgentStatus.suspended);
    });

    it('しきい値を越えていれば発火を数える', async () => {
      // エージェントを 1 件作る
      const a = await makeTenant('a');
      const agentId = await makeAgent(a, 'bot');
      // 必ず越えるコストのルール（しきい値 0 マイクロ USD）
      const rule = await repos.guardrailRules.create(
        {
          tenantId: a,
          agentId,
          kind: RuleKind.cost,
          threshold: 0,
          windowMinutes: 60,
          action: RuleAction.notify,
        },
        { maxEnabled: 50, maxRows: 200 },
      );
      if (rule.status !== 'created') throw new Error('ルールを作れません');
      // 窓に入る利用イベントを 1 件記録する
      await repos.usageEvents.record({
        tenantId: a,
        agentId,
        provider: Provider.anthropic,
        model: MODEL,
        inputTokens: 1,
        outputTokens: 1,
        costMicroUsd: 1n,
        latencyMs: 1,
        statusCode: 200,
      });
      // **基準時刻は少し先にする** — memory の記録は実時刻で入るので、いまを終端にすると
      // 直前の行が窓の外（終端より後）に落ちる
      const result = await run({ now: new Date(Date.now() + 1_000) });
      // 判定して発火している
      expect(result.rulesEvaluated).toBe(1);
      expect(result.fired).toBe(1);
      expect(result.failed).toBe(0);
    });

    it('判定が失敗したエージェントは failed に数えて続ける（1 件で掃きを止めない）', async () => {
      // 2 テナント × 1 エージェント
      const a = await makeTenant('a');
      const b = await makeTenant('b');
      await makeAgent(a, 'a1');
      await makeAgent(b, 'b1');
      // 有効ルールの読み出しを 1 回だけ失敗させる
      const original = repos.guardrailRules.findActiveRules.bind(repos.guardrailRules);
      let calls = 0;
      vi.spyOn(repos.guardrailRules, 'findActiveRules').mockImplementation(async (...args) => {
        calls += 1;
        if (calls === 1) throw new Error('読み出しに失敗');
        return original(...args);
      });
      // 一巡を始める
      const result = await run();
      // 2 件とも判定を試み、1 件は失敗として数え、一巡は終わっている
      expect(result.agentsEvaluated).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.passComplete).toBe(true);
    });
  });

  describe('続きの位置（カーソル）', () => {
    it('予算を使い切ったら次のテナントの先頭から続ける', async () => {
      // 2 テナント × 1 エージェント、予算は 1 件
      const a = await makeTenant('a');
      await makeTenant('b');
      await makeAgent(a, 'a1');
      const b2 = await repos.tenants.list({ limit: 10 });
      // 並びは createdAt 昇順なので 1 件目が a
      expect(b2.items[0]?.id).toBe(a);
      // 1 件だけ判定する
      const first = await run({ agentBudget: 1 });
      // 1 件判定し、まだ終わっていない
      expect(first.agentsEvaluated).toBe(1);
      expect(first.passComplete).toBe(false);
      // **テナントのカーソルは 1 件目を指し、エージェントのカーソルは無い**（次のテナントの先頭から）
      expect(first.nextTenantCursor).not.toBeNull();
      expect(first.nextAgentCursor).toBeNull();
    });

    it('同じテナントにエージェントが残っていればテナントのカーソルを進めない（取りこぼさない）', async () => {
      // 1 テナントに 2 エージェント、予算は 1 件
      const a = await makeTenant('a');
      await makeAgent(a, 'a1');
      await makeAgent(a, 'a2');
      // 1 件だけ判定する
      const first = await run({ agentBudget: 1 });
      expect(first.agentsEvaluated).toBe(1);
      expect(first.passComplete).toBe(false);
      // **1 件目のテナントなので「先頭から」= null、エージェントのカーソルは 2 件目を指す**
      expect(first.nextTenantCursor).toBeNull();
      expect(first.nextAgentCursor).not.toBeNull();
    });

    it('`passComplete` が真になるまで繰り返すと、全エージェントをちょうど 1 回ずつ判定する', async () => {
      // 3 テナント × 3 エージェント = 9 件
      const tenants = await Promise.all([makeTenant('a'), makeTenant('b'), makeTenant('c')]);
      for (const tenantId of tenants) {
        for (const name of ['1', '2', '3']) await makeAgent(tenantId, name);
      }
      // 予算 2 件で回し切る（続きのカーソルをそのまま渡し直す）
      let evaluated = 0;
      let tenantCursor: Parameters<typeof runMaintenance>[1]['tenantCursor'];
      let agentCursor: Parameters<typeof runMaintenance>[1]['agentCursor'];
      // 無限ループを避ける上限（9 件を 2 件ずつなので 5 回で足りる）
      for (let round = 0; round < 20; round += 1) {
        const result = await run({ agentBudget: 2, tenantCursor, agentCursor });
        evaluated += result.agentsEvaluated;
        if (result.passComplete) break;
        // 返ったカーソルを復号して次へ渡す（API 層がやることと同じ）
        const { decodeCursor } = await import('@/data/page');
        tenantCursor =
          result.nextTenantCursor === null
            ? undefined
            : (decodeCursor(result.nextTenantCursor) ?? undefined);
        agentCursor =
          result.nextAgentCursor === null
            ? undefined
            : (decodeCursor(result.nextAgentCursor) ?? undefined);
      }
      // **ちょうど 9 件**（取りこぼしも二重判定も無い）
      expect(evaluated).toBe(9);
    });
  });
});
