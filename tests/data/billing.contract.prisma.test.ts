// 課金 (Step6) まわりの契約テスト (実 PostgreSQL)。
// **memory アダプタでは見えないもの**をここで固定する:
//   - `Tenant.billingCustomerId` / `billingSubscriptionId` の一意索引が 2 行目を拒否すること
//   - `BillingEvent` の `@@unique([provider, eventId])` が **同時に届いた 2 通**でも 1 通だけを
//     `recorded` にすること (受け入れ基準②「Webhook 冪等性」の本体。「処理済みか先に SELECT」の
//     形では両方が通るので、制約に任せていることを実 DB でしか確かめられない)
//   - 受信記録がテナントの削除で Cascade されること
//   - エージェント数の上限を**挿入と同じトランザクションの中で**数えていること
//     (テナント行のロックの存在を、別のトランザクションで掴んで決定的に確かめる)
// RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で全テーブルを TRUNCATE するため開発 DB を指さない
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DuplicateError } from '@/data/errors';
import type { CreateAgentInput, Repositories } from '@/data/ports';
import { Plan, Provider } from '@/domain/types';
import { userTokenExpiresAt } from '@/lib/tokens';
import { runContractDatabaseGuard } from '../../scripts/lib/contract-database.mjs';

// 明示フラグが無ければ丸ごとスキップする
const ENABLED = process.env.RUN_PRISMA_CONTRACT === '1';

// テストで発行するトークンの有効期間 (日)
const TOKEN_TTL_DAYS = 1;
// エージェントが使うモデル名
const MODEL = 'claude-sonnet-4-6';
// 課金事業者の名前 (いまは stripe の 1 つだけ)
const PROVIDER = 'stripe';
// ロックの存在を確かめるときの待ち時間 (これだけ待っても終わらなければ「待たされている」)
const LOCK_TEST_WAIT_MS = 500;
// ロックを掴んだままにするトランザクションの上限 (既定の 5 秒だと待ちの間に時間切れになる)
const LOCK_TEST_TRANSACTION_TIMEOUT_MS = 10_000;

// テナントを 1 つ作って id を返す
async function makeTenant(repos: Repositories, label: string): Promise<string> {
  // テナントと初期 admin とそのトークンをまとめて作る
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
  return created.tenant.id;
}

// エージェント作成の最小限の入力 (上限の判定を主題にするテストが使う)
function agentInput(tenantId: string, name: string): CreateAgentInput {
  return {
    tenantId,
    name,
    description: null,
    provider: Provider.anthropic,
    model: MODEL,
    budgetMicroUsd: null,
  };
}

describe.skipIf(!ENABLED)('課金とプランの契約', () => {
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

  it('作ったばかりのテナントは free で課金 ID を持たない', async () => {
    // DB の既定値 (スキーマの @default(free) と nullable な 2 列) を実 DB で確かめる
    const tenantId = await makeTenant(repos, 'default');
    const tenant = await repos.tenants.findById(tenantId);
    expect(tenant?.plan).toBe(Plan.free);
    expect(tenant?.billingCustomerId).toBeNull();
    expect(tenant?.billingSubscriptionId).toBeNull();
  });

  it('プランと課金 ID を同時に書き、顧客 ID で引ける', async () => {
    // 連携の成立 (Webhook の 1 通目でこの形になる)
    const tenantId = await makeTenant(repos, 'link');
    const updated = await repos.tenants.updatePlan(tenantId, {
      plan: Plan.pro,
      billingCustomerId: 'cus_link',
      billingSubscriptionId: 'sub_link',
    });
    expect(updated?.plan).toBe(Plan.pro);
    // 顧客 ID から引ける (Webhook が「どのテナントか」を決める唯一の経路)
    expect((await repos.tenants.findByBillingCustomerId('cus_link'))?.id).toBe(tenantId);
  });

  it('課金 ID を省いた更新は既存の値を消さない', async () => {
    // 省略は「変更しない」で、null で上書きではない (undefined を data へ流すと消える)
    const tenantId = await makeTenant(repos, 'keep');
    await repos.tenants.updatePlan(tenantId, {
      plan: Plan.pro,
      billingCustomerId: 'cus_keep',
      billingSubscriptionId: 'sub_keep',
    });
    const updated = await repos.tenants.updatePlan(tenantId, { plan: Plan.enterprise });
    expect(updated?.plan).toBe(Plan.enterprise);
    expect(updated?.billingCustomerId).toBe('cus_keep');
    expect(updated?.billingSubscriptionId).toBe('sub_keep');
  });

  it('null を渡したときだけ未連携へ戻す', async () => {
    // 解約で紐付けを外す経路
    const tenantId = await makeTenant(repos, 'unlink');
    await repos.tenants.updatePlan(tenantId, { plan: Plan.pro, billingCustomerId: 'cus_unlink' });
    const updated = await repos.tenants.updatePlan(tenantId, {
      plan: Plan.free,
      billingCustomerId: null,
    });
    expect(updated?.billingCustomerId).toBeNull();
    expect(await repos.tenants.findByBillingCustomerId('cus_unlink')).toBeNull();
  });

  it('同じ顧客 ID を 2 テナントが名乗れない (一意索引)', async () => {
    // 一意索引が 2 行目を拒否し、アダプタが DuplicateError へ翻訳する
    const a = await makeTenant(repos, 'dup-a');
    const b = await makeTenant(repos, 'dup-b');
    await repos.tenants.updatePlan(a, { plan: Plan.pro, billingCustomerId: 'cus_shared' });
    await expect(
      repos.tenants.updatePlan(b, { plan: Plan.pro, billingCustomerId: 'cus_shared' }),
    ).rejects.toBeInstanceOf(DuplicateError);
  });

  it('衝突した列の名前を取り違えない (顧客 ID とサブスクリプション ID)', async () => {
    // **memory 側と答えをそろえる** — 列名は 422 の issues.path に出るので、固定の名前を返すと
    // 「サブスクリプション ID が衝突したのに顧客 ID のせいだ」と答える形になる
    const a = await makeTenant(repos, 'field-a');
    const b = await makeTenant(repos, 'field-b');
    await repos.tenants.updatePlan(a, {
      plan: Plan.pro,
      billingCustomerId: 'cus_field_a',
      billingSubscriptionId: 'sub_shared',
    });
    await expect(
      repos.tenants.updatePlan(b, {
        plan: Plan.pro,
        billingCustomerId: 'cus_field_b',
        billingSubscriptionId: 'sub_shared',
      }),
    ).rejects.toMatchObject({ field: 'billingSubscriptionId' });
  });

  it('自分自身の課金 ID を書き直すのは衝突にならない', async () => {
    // Webhook の再送で同じ値をもう一度書く形
    const tenantId = await makeTenant(repos, 'self');
    await repos.tenants.updatePlan(tenantId, { plan: Plan.pro, billingCustomerId: 'cus_self' });
    const updated = await repos.tenants.updatePlan(tenantId, {
      plan: Plan.pro,
      billingCustomerId: 'cus_self',
    });
    expect(updated?.billingCustomerId).toBe('cus_self');
  });

  it('居ないテナントの更新と引けない顧客 ID は null', async () => {
    // P2025 を null へ翻訳していること (例外にすると Webhook が 500 を返して再送が増える)
    expect(await repos.tenants.updatePlan('tenant_missing', { plan: Plan.pro })).toBeNull();
    expect(await repos.tenants.findByBillingCustomerId('cus_missing')).toBeNull();
  });

  it('同じイベントの 2 通目は duplicate になる', async () => {
    // 冪等性の基本形 (再送は正常系なので例外にしない)
    const tenantId = await makeTenant(repos, 'idem');
    const input = { provider: PROVIDER, eventId: 'evt_idem', type: 'x.updated', tenantId };
    expect(await repos.billingEvents.recordOnce(input)).toBe('recorded');
    expect(await repos.billingEvents.recordOnce(input)).toBe('duplicate');
    // 行は 1 件だけ (2 通目で記録が増えない)
    expect(await client.billingEvent.count({ where: { eventId: 'evt_idem' } })).toBe(1);
  });

  it('同時に届いた 2 通でも 1 通だけが recorded になる (一意制約に任せていること)', async () => {
    // **これが「処理済みか先に SELECT してから INSERT」との差が出る唯一の検査。**
    // 先に読む形だと、どちらの呼び出しも「未処理」を読んで両方が recorded になる
    const tenantId = await makeTenant(repos, 'race');
    const input = { provider: PROVIDER, eventId: 'evt_race', type: 'x.updated', tenantId };
    // 2 通を同時に投げる
    const results = await Promise.all([
      repos.billingEvents.recordOnce(input),
      repos.billingEvents.recordOnce(input),
    ]);
    // 片方だけが recorded (順序は運なので数で見る)
    expect(results.filter((result) => result === 'recorded')).toHaveLength(1);
    expect(results.filter((result) => result === 'duplicate')).toHaveLength(1);
    // 行も 1 件だけ
    expect(await client.billingEvent.count({ where: { eventId: 'evt_race' } })).toBe(1);
  });

  it('事業者が違えば同じイベント ID でも別の記録になる', async () => {
    // 一意制約の粒度が (provider, eventId) であること (eventId 単独だと片方を落とす)
    const tenantId = await makeTenant(repos, 'provider');
    const base = { eventId: 'evt_same', type: 'x.updated', tenantId };
    expect(await repos.billingEvents.recordOnce({ ...base, provider: PROVIDER })).toBe('recorded');
    expect(await repos.billingEvents.recordOnce({ ...base, provider: 'other' })).toBe('recorded');
  });

  it('テナントが決まらないイベントも記録でき、冪等である', async () => {
    // 顧客 ID からテナントを引けなかった場合。記録しないと再送のたびに同じ処理を繰り返す
    const input = {
      provider: PROVIDER,
      eventId: 'evt_orphan',
      type: 'x.updated',
      tenantId: null,
    };
    expect(await repos.billingEvents.recordOnce(input)).toBe('recorded');
    expect(await repos.billingEvents.recordOnce(input)).toBe('duplicate');
  });

  it('テナントを消すと受信記録も消える (Cascade)', async () => {
    // 記録は設定ではなく「受け取った事実」なので履歴側 (Restrict) ではなく Cascade にしてある。
    // Restrict だとテナントを消せなくなる
    const tenantId = await makeTenant(repos, 'cascade');
    await repos.billingEvents.recordOnce({
      provider: PROVIDER,
      eventId: 'evt_cascade',
      type: 'x.updated',
      tenantId,
    });
    // テナント行を消す
    await client.tenant.delete({ where: { id: tenantId } });
    // 受信記録も消えている
    expect(await client.billingEvent.count({ where: { eventId: 'evt_cascade' } })).toBe(0);
  });

  it('認証経路の照合が現在のプランを一緒に返す (ユーザートークン / API キー)', async () => {
    // **プランは認証と同じ 1 回の問い合わせで引く** (別の往復にすると全 API に 1 回増える)。
    // ここが固定値や写しだと、プランを変えても機能ゲートが古い値で動く。
    // memory 側と同じ期待を `tests/data/memory-billing.test.ts` にも書いてある
    const tokenHash = `hash-plan-${Date.now()}-${Math.random()}`;
    const created = await repos.tenants.createWithAdmin({
      name: 'テナント plan',
      admin: { email: 'admin-plan@example.com', name: '管理者' },
      token: {
        prefix: 'aop_u_test',
        tokenHash,
        name: '初期',
        expiresAt: userTokenExpiresAt(TOKEN_TTL_DAYS),
      },
    });
    // そのテナントにエージェントと API キーを 1 つずつ
    const agent = await repos.agents.create(agentInput(created.tenant.id, 'bot'), {
      maxAgents: 10,
    });
    if (agent.status !== 'created') throw new Error('エージェントを作れません');
    const keyHash = `hash-key-${Date.now()}-${Math.random()}`;
    await repos.apiKeys.create({
      tenantId: created.tenant.id,
      agentId: agent.agent.id,
      name: 'key',
      prefix: 'aop_k_test',
      keyHash,
    });
    // 既定は free
    expect((await repos.userTokens.findByHash(tokenHash))?.plan).toBe(Plan.free);
    expect((await repos.apiKeys.findByHash(keyHash))?.plan).toBe(Plan.free);
    // プランを上げると照合の結果も変わる
    await repos.tenants.updatePlan(created.tenant.id, { plan: Plan.enterprise });
    expect((await repos.userTokens.findByHash(tokenHash))?.plan).toBe(Plan.enterprise);
    expect((await repos.apiKeys.findByHash(keyHash))?.plan).toBe(Plan.enterprise);
  });

  it('エージェント数の上限に達したら too_many_agents を返す', async () => {
    // 上限 2 のテナントに 3 件目を作らせない (数え方は自テナントの行だけ)
    const tenantId = await makeTenant(repos, 'limit');
    const limits = { maxAgents: 2 };
    expect((await repos.agents.create(agentInput(tenantId, 'a1'), limits)).status).toBe('created');
    expect((await repos.agents.create(agentInput(tenantId, 'a2'), limits)).status).toBe('created');
    expect((await repos.agents.create(agentInput(tenantId, 'a3'), limits)).status).toBe(
      'too_many_agents',
    );
  });

  it('上限は自テナントの行だけで数える', async () => {
    // 他テナントが上限まで作っていても自テナントの枠は減らない (ADR-0002 の行スコープ)
    const a = await makeTenant(repos, 'scope-a');
    const b = await makeTenant(repos, 'scope-b');
    const limits = { maxAgents: 2 };
    await repos.agents.create(agentInput(b, 'b1'), limits);
    await repos.agents.create(agentInput(b, 'b2'), limits);
    expect((await repos.agents.create(agentInput(a, 'a1'), limits)).status).toBe('created');
  });

  it('上限に達していても名前の重複を先に落とす', async () => {
    // **memory 側と判定の順序をそろえる** — 割れると同じ要求の答えが 409 と 422 に分かれる
    const tenantId = await makeTenant(repos, 'order');
    const limits = { maxAgents: 2 };
    await repos.agents.create(agentInput(tenantId, 'same'), limits);
    await repos.agents.create(agentInput(tenantId, 'other'), limits);
    await expect(repos.agents.create(agentInput(tenantId, 'same'), limits)).rejects.toMatchObject({
      field: 'name',
    });
  });

  // 上の上限のテストは要求が直列に流れるため、**ロック句を落としても緑のまま通る**。
  // そこで「同じテナント行を別のトランザクションが掴んでいる間、作成が待たされる」ことを
  // 決定的に確かめる (監査ログの採番・最後の admin 判定と同じ手口。理由も同じ —
  // 数えてから挿入する形に分けると、同時の 2 件がどちらも上限未満を読んで上限を超える)
  it('同じテナント行を掴んでいる間、エージェントの作成は待たされる (上限の数えのロック)', async () => {
    // テナントを 1 つ
    const tenantId = await makeTenant(repos, 'lock');
    // ロックを離す合図
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    // ロックを掴んだ合図 (掴む前に作成を始めると、どちらが先に行を取るかは運になり誤った赤が出る)
    let signalHeld = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    // 別のトランザクションでテナント行を掴んだまま待つ
    const holding = client.$transaction(
      async (tx) => {
        // 作成が取るのと同じ行・同じ強さのロック
        await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR NO KEY UPDATE`;
        // 掴めたことを知らせる
        signalHeld();
        // 合図が来るまで保持する
        await released;
      },
      { timeout: LOCK_TEST_TRANSACTION_TIMEOUT_MS },
    );
    // 掴むまで作成を始めない
    await held;
    // 作成を始める (ロックが効いていれば、掴んでいる間は終わらない)
    const creating = repos.agents.create(agentInput(tenantId, 'locked'), { maxAgents: 10 });
    try {
      // 待たされていること (先に時間切れの方が返る)
      const finishedFirst = await Promise.race([
        creating.then(() => 'created' as const),
        new Promise<'blocked'>((resolve) =>
          setTimeout(() => resolve('blocked'), LOCK_TEST_WAIT_MS),
        ),
      ]);
      expect(finishedFirst).toBe('blocked');
    } finally {
      // 失敗しても必ず離す (掴んだまま抜けると、次のテストの TRUNCATE が道連れで落ちる)
      release();
      await holding;
    }
    // ロックを離した後は作成が通る
    expect((await creating).status).toBe('created');
  });
});
