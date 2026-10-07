// 課金まわりの Port（テナントのプラン更新・顧客 ID 引き・受信イベントの冪等な記録）を
// memory 側でも固定する。
//
// **ADR-0006 の死角への手当て。** この 3 操作は Webhook とプラットフォーム管理者しか呼ばないので、
// memory 側が prisma より緩い（顧客 ID の一意性を見ない・2 通目を `recorded` と答える）と、
// API テストは緑のまま本番だけ別の挙動になる。とくに冪等性が memory でだけ緩いと、
// 受け入れ基準②（Webhook 冪等性）を API テストで確かめているつもりで何も確かめていない形になる。
// 同じ期待を `tests/data/billing.contract.prisma.test.ts` にも書く（ここは意図的に対にする）。
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryRepos, MemoryStore } from '@/data/adapters/memory';
import { DuplicateError } from '@/data/errors';
import type { Repositories, RecordBillingEventInput } from '@/data/ports';
import { Plan, Provider } from '@/domain/types';
// エージェントを作るテスト用ヘルパー (上限は必須引数なので 1 か所にまとめる)
import { createTestAgent } from '../lib/agent-limits';

// テナントを 1 つ作って id を返す（名前とメールだけ変えて複数作れるようにする）
async function makeTenant(repos: Repositories, label: string): Promise<string> {
  // テナントと最初の admin をまとめて作る
  const created = await repos.tenants.createWithAdmin({
    name: `テナント${label}`,
    admin: { email: `admin-${label}@example.com`, name: '管理者' },
    token: {
      prefix: `aop_u_${label}`,
      tokenHash: `hash-${label}`,
      name: '初期',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return created.tenant.id;
}

/**
 * 反映を渡さずに受信だけを記録する（`outcome` だけを見たいテスト用の薄い包み）。
 *
 * **`recordOnce` の反映は省略可にしていない**（渡し忘れが静かに「記録だけ」へ戻るのを防ぐため）
 * ので、テスト側で `null` を書き並べる代わりにここへ寄せる。
 */
async function recordWithoutApply(
  repos: Repositories,
  input: RecordBillingEventInput,
): Promise<string> {
  // 反映なしで記録し、結果の種類だけを返す
  const result = await repos.billingEvents.recordOnce(input, null);
  return result.outcome;
}

describe('memory アダプタ: テナントのプラン更新', () => {
  // 表とリポジトリ（テストごとに作り直す）
  let repos: Repositories;

  beforeEach(() => {
    // 新しい表で組み立てる
    repos = createMemoryRepos(new MemoryStore());
  });

  it('作ったばかりのテナントは free で課金 ID を持たない', async () => {
    // テナントを作る
    const tenantId = await makeTenant(repos, 'A');
    // 既定のプランと課金 ID を確かめる（Webhook が来るまでは未連携）
    const tenant = await repos.tenants.findById(tenantId);
    expect(tenant?.plan).toBe(Plan.free);
    expect(tenant?.billingCustomerId).toBeNull();
    expect(tenant?.billingSubscriptionId).toBeNull();
  });

  it('プランと課金 ID を同時に書き、顧客 ID で引けるようになる', async () => {
    // テナントを作る
    const tenantId = await makeTenant(repos, 'A');
    // プランと課金事業者側の id を一緒に書く（別の操作に分けると片方だけ成功した状態が残る）
    const updated = await repos.tenants.updatePlan(tenantId, {
      plan: Plan.pro,
      billingCustomerId: 'cus_A',
      billingSubscriptionId: 'sub_A',
    });
    // 3 つとも入っている
    expect(updated?.plan).toBe(Plan.pro);
    expect(updated?.billingCustomerId).toBe('cus_A');
    expect(updated?.billingSubscriptionId).toBe('sub_A');
    // 顧客 ID から引ける（次の Webhook がテナントを決める唯一の経路）
    expect((await repos.tenants.findByBillingCustomerId('cus_A'))?.id).toBe(tenantId);
  });

  it('課金 ID を省いた更新は既存の値を消さない', async () => {
    // 一度 ID まで書いてから、プランだけを変える
    const tenantId = await makeTenant(repos, 'A');
    await repos.tenants.updatePlan(tenantId, {
      plan: Plan.pro,
      billingCustomerId: 'cus_A',
      billingSubscriptionId: 'sub_A',
    });
    // プランだけ指定する（省略は「変更しない」で、null で上書きではない）
    const updated = await repos.tenants.updatePlan(tenantId, { plan: Plan.enterprise });
    expect(updated?.plan).toBe(Plan.enterprise);
    expect(updated?.billingCustomerId).toBe('cus_A');
    expect(updated?.billingSubscriptionId).toBe('sub_A');
  });

  it('null を渡したときだけ未連携へ戻す', async () => {
    // 連携済みにしてから明示的に null を渡す（解約で紐付けを外す経路）
    const tenantId = await makeTenant(repos, 'A');
    await repos.tenants.updatePlan(tenantId, { plan: Plan.pro, billingCustomerId: 'cus_A' });
    const updated = await repos.tenants.updatePlan(tenantId, {
      plan: Plan.free,
      billingCustomerId: null,
    });
    // 顧客 ID が消え、引けなくなる
    expect(updated?.billingCustomerId).toBeNull();
    expect(await repos.tenants.findByBillingCustomerId('cus_A')).toBeNull();
  });

  it('同じ顧客 ID を 2 テナントが名乗れない', async () => {
    // 2 テナントを作り、片方に顧客 ID を付ける
    const a = await makeTenant(repos, 'A');
    const b = await makeTenant(repos, 'B');
    await repos.tenants.updatePlan(a, { plan: Plan.pro, billingCustomerId: 'cus_SHARED' });
    // もう一方が同じ顧客 ID を名乗ると一意制約違反（本番は一意索引が拒否する）
    await expect(
      repos.tenants.updatePlan(b, { plan: Plan.pro, billingCustomerId: 'cus_SHARED' }),
    ).rejects.toBeInstanceOf(DuplicateError);
  });

  it('同じサブスクリプション ID も 2 テナントが名乗れない', async () => {
    // 顧客 ID は別、サブスクリプション ID だけが同じ形
    const a = await makeTenant(repos, 'A');
    const b = await makeTenant(repos, 'B');
    await repos.tenants.updatePlan(a, {
      plan: Plan.pro,
      billingCustomerId: 'cus_A',
      billingSubscriptionId: 'sub_SHARED',
    });
    // 衝突した列の名前まで確かめる（422 の issues.path に出る値なので、両アダプタでそろえる）
    await expect(
      repos.tenants.updatePlan(b, {
        plan: Plan.pro,
        billingCustomerId: 'cus_B',
        billingSubscriptionId: 'sub_SHARED',
      }),
    ).rejects.toMatchObject({ field: 'billingSubscriptionId' });
  });

  it('自分自身の課金 ID を書き直すのは衝突にならない', async () => {
    // 同じ値をもう一度書く（Webhook の再送でよく起きる）
    const tenantId = await makeTenant(repos, 'A');
    await repos.tenants.updatePlan(tenantId, { plan: Plan.pro, billingCustomerId: 'cus_A' });
    // 2 回目も通る（自分の行は衝突の相手にしない）
    const updated = await repos.tenants.updatePlan(tenantId, {
      plan: Plan.pro,
      billingCustomerId: 'cus_A',
    });
    expect(updated?.billingCustomerId).toBe('cus_A');
  });

  it('居ないテナントの更新と引けない顧客 ID は null', async () => {
    // 対象が無ければ例外ではなく null（Webhook は「対応するテナントが無い」を普通に受け取る）
    expect(await repos.tenants.updatePlan('tenant_missing', { plan: Plan.pro })).toBeNull();
    expect(await repos.tenants.findByBillingCustomerId('cus_missing')).toBeNull();
  });
});

describe('memory アダプタ: 受信した課金イベントの冪等な記録', () => {
  // 表とリポジトリ
  let repos: Repositories;

  beforeEach(() => {
    repos = createMemoryRepos(new MemoryStore());
  });

  it('同じイベントの 2 通目は duplicate になる', async () => {
    // テナントを 1 つ用意して受信記録を作る
    const tenantId = await makeTenant(repos, 'A');
    const input = {
      provider: 'stripe',
      eventId: 'evt_1',
      type: 'customer.subscription.updated',
      tenantId,
    };
    // 1 通目は記録、2 通目は既に記録済み（例外にしない — 再送は正常系）
    expect(await recordWithoutApply(repos, input)).toBe('recorded');
    expect(await recordWithoutApply(repos, input)).toBe('duplicate');
  });

  it('イベント ID が違えば別の記録になる', async () => {
    // 同じ事業者・同じ種別でも ID が違えば別イベント
    const tenantId = await makeTenant(repos, 'A');
    const base = { provider: 'stripe', type: 'customer.subscription.deleted', tenantId };
    expect(await recordWithoutApply(repos, { ...base, eventId: 'evt_1' })).toBe('recorded');
    expect(await recordWithoutApply(repos, { ...base, eventId: 'evt_2' })).toBe('recorded');
  });

  it('事業者が違えば同じイベント ID でも別の記録になる', async () => {
    // 一意制約の粒度は (provider, eventId)。事業者をまたいだ ID の衝突で片方を落とさない
    const tenantId = await makeTenant(repos, 'A');
    const base = { eventId: 'evt_1', type: 'customer.subscription.updated', tenantId };
    expect(await recordWithoutApply(repos, { ...base, provider: 'stripe' })).toBe('recorded');
    expect(await recordWithoutApply(repos, { ...base, provider: 'other' })).toBe('recorded');
  });

  it('テナントが決まらないイベントも記録できる', async () => {
    // 顧客 ID からテナントを引けなかった場合（tenantId は null）。
    // 記録しないと「知らない顧客からの再送」を何度でも処理してしまう
    expect(
      await recordWithoutApply(repos, {
        provider: 'stripe',
        eventId: 'evt_orphan',
        type: 'customer.subscription.updated',
        tenantId: null,
      }),
    ).toBe('recorded');
    // 2 通目は duplicate（テナント不明でも冪等であること）
    expect(
      await recordWithoutApply(repos, {
        provider: 'stripe',
        eventId: 'evt_orphan',
        type: 'customer.subscription.updated',
        tenantId: null,
      }),
    ).toBe('duplicate');
  });

  // --- 受信の記録とプランの反映が同じ原子的操作であること（prisma 側の契約テストと同じ期待） ---

  it('反映を渡すと受信記録と同時にプランが変わる', async () => {
    // free のテナントを 1 つ用意する
    const tenantId = await makeTenant(repos, 'A');
    // 受信を記録しつつ pro へ上げる
    const result = await repos.billingEvents.recordOnce(
      { provider: 'stripe', eventId: 'evt_apply', type: 'customer.subscription.updated', tenantId },
      { tenantId, update: { plan: Plan.pro, billingSubscriptionId: 'sub_1' } },
    );
    // 初めての記録で、反映後の行が返る
    expect(result.outcome).toBe('recorded');
    expect(result.tenant?.plan).toBe(Plan.pro);
    expect(result.tenant?.billingSubscriptionId).toBe('sub_1');
    // 表の行も変わっている
    expect((await repos.tenants.findById(tenantId))?.plan).toBe(Plan.pro);
  });

  it('2 通目は反映もしない（プランが動かない）', async () => {
    // pro へ上げたあと、同じイベントで free へ落とす指示を送る
    const tenantId = await makeTenant(repos, 'A');
    const input = {
      provider: 'stripe',
      eventId: 'evt_twice',
      type: 'customer.subscription.updated',
      tenantId,
    };
    await repos.billingEvents.recordOnce(input, { tenantId, update: { plan: Plan.pro } });
    // 2 通目（同じ ID）は何も書かない
    const second = await repos.billingEvents.recordOnce(input, {
      tenantId,
      update: { plan: Plan.free },
    });
    expect(second.outcome).toBe('duplicate');
    expect(second.tenant).toBeNull();
    // プランは 1 通目のまま（2 通目の指示が効いていない）
    expect((await repos.tenants.findById(tenantId))?.plan).toBe(Plan.pro);
  });

  it('反映の対象が居なければ記録だけ残る', async () => {
    // 居ないテナントへの反映を渡す（再送しても結果は変わらないので記録は残す）
    const result = await repos.billingEvents.recordOnce(
      {
        provider: 'stripe',
        eventId: 'evt_gone',
        type: 'customer.subscription.deleted',
        tenantId: null,
      },
      { tenantId: 'tenant_missing', update: { plan: Plan.free } },
    );
    // 記録はされ、反映後の行は無い
    expect(result.outcome).toBe('recorded');
    expect(result.tenant).toBeNull();
    // 2 通目は duplicate（記録が残っている証拠）
    expect(
      await recordWithoutApply(repos, {
        provider: 'stripe',
        eventId: 'evt_gone',
        type: 'customer.subscription.deleted',
        tenantId: null,
      }),
    ).toBe('duplicate');
  });

  it('反映が失敗したら受信記録も残らない（再送でやり直せる）', async () => {
    // **これが「記録してから別の操作で反映する」との差が出る検査。** 記録だけ先に確定する形だと、
    // 反映に失敗したイベントが「もう処理した」になり再送でも永久にやり直せない
    const first = await makeTenant(repos, 'A');
    const second = await makeTenant(repos, 'B');
    // B に既にあるサブスクリプション ID を A へ付けようとして一意制約違反を起こす
    await repos.tenants.updatePlan(second, { plan: Plan.pro, billingSubscriptionId: 'sub_taken' });
    await expect(
      repos.billingEvents.recordOnce(
        {
          provider: 'stripe',
          eventId: 'evt_fail',
          type: 'customer.subscription.updated',
          tenantId: first,
        },
        { tenantId: first, update: { plan: Plan.pro, billingSubscriptionId: 'sub_taken' } },
      ),
    ).rejects.toBeInstanceOf(DuplicateError);
    // 記録が残っていないので、同じ ID の再送は「初めて」として扱える
    expect(
      await recordWithoutApply(repos, {
        provider: 'stripe',
        eventId: 'evt_fail',
        type: 'customer.subscription.updated',
        tenantId: first,
      }),
    ).toBe('recorded');
    // A のプランも巻き戻っている（反映されていない）
    expect((await repos.tenants.findById(first))?.plan).toBe(Plan.free);
  });
});

describe('memory アダプタ: 認証経路が返すプラン', () => {
  // 表とリポジトリ
  let repos: Repositories;

  beforeEach(() => {
    repos = createMemoryRepos(new MemoryStore());
  });

  it('ユーザートークンの照合は現在のプランを一緒に返す', async () => {
    // **プランは認証と同じ 1 回の問い合わせで引く**ので、ここが固定値だと機能ゲートが
    // 「どのテナントも同じプラン」で動いてしまう（しかも API テストは緑のまま）
    const created = await repos.tenants.createWithAdmin({
      name: 'テナント',
      admin: { email: 'admin@example.com', name: '管理者' },
      token: {
        prefix: 'aop_u_t',
        tokenHash: 'hash-plan',
        name: '初期',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    // 既定は free
    expect((await repos.userTokens.findByHash('hash-plan'))?.plan).toBe(Plan.free);
    // プランを上げると照合の結果も変わる（写しを持っていないこと）
    await repos.tenants.updatePlan(created.tenant.id, { plan: Plan.enterprise });
    expect((await repos.userTokens.findByHash('hash-plan'))?.plan).toBe(Plan.enterprise);
  });

  it('API キーの照合も現在のプランを一緒に返す', async () => {
    // 中継はプラン別の枠でレート制限するので、キーの照合でもプランが要る
    const created = await repos.tenants.createWithAdmin({
      name: 'テナント',
      admin: { email: 'admin@example.com', name: '管理者' },
      token: {
        prefix: 'aop_u_t',
        tokenHash: 'hash-key-plan',
        name: '初期',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    // そのテナントにエージェントとキーを 1 つずつ
    const agent = await createTestAgent(repos, {
      tenantId: created.tenant.id,
      name: 'bot',
      description: null,
      provider: Provider.anthropic,
      model: 'claude-sonnet-4-6',
      budgetMicroUsd: null,
    });
    await repos.apiKeys.create({
      tenantId: created.tenant.id,
      agentId: agent.id,
      name: 'key',
      prefix: 'aop_k_t',
      keyHash: 'hash-key',
    });
    // 既定は free
    expect((await repos.apiKeys.findByHash('hash-key'))?.plan).toBe(Plan.free);
    // プランを上げると照合の結果も変わる
    await repos.tenants.updatePlan(created.tenant.id, { plan: Plan.pro });
    expect((await repos.apiKeys.findByHash('hash-key'))?.plan).toBe(Plan.pro);
  });
});
