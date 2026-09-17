// prisma アダプタの契約テスト (実 PostgreSQL)。memory アダプタと同じ挙動 (テナント境界・一意制約・複合 FK・
// Restrict / Cascade・ページネーション) を本番実装で固定する。
// RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で全テーブルを TRUNCATE するため開発 DB を指さないこと
// (CI は専用 DB agent_ops_contract を作って流す。CLAUDE.md §2)
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaRepos } from '@/data/adapters/prisma';
import { DuplicateError } from '@/data/errors';
import type { Repositories } from '@/data/ports';
import { Provider, Role } from '@/domain/types';
import type { PrismaClient } from '@/generated/prisma';
import { createPrismaClient } from '@/lib/prisma-client';

// 明示フラグが無ければ丸ごとスキップする
const ENABLED = process.env.RUN_PRISMA_CONTRACT === '1';
// 1 日のミリ秒
const DAY_MS = 24 * 60 * 60 * 1000;

// テナントを 1 つ作る (admin + トークン込み)
async function makeTenant(repos: Repositories, label: string) {
  // ハッシュはテストごとに一意ならよい
  return repos.tenants.createWithAdmin({
    name: `テナント${label}`,
    admin: { email: `admin-${label}@example.com`, name: `管理者${label}` },
    token: {
      prefix: 'aop_u_test',
      tokenHash: `hash-${label}-${Date.now()}`,
      name: '初期',
      expiresAt: new Date(Date.now() + DAY_MS),
    },
  });
}

describe.skipIf(!ENABLED)('prisma アダプタの契約', () => {
  // 実 DB へのクライアントとリポジトリ
  let client: PrismaClient;
  let repos: Repositories;

  // 接続する
  beforeAll(() => {
    client = createPrismaClient();
    repos = createPrismaRepos(client);
  });

  // 全テーブルを空にする (Tenant を起点に CASCADE で子も消える)
  beforeEach(async () => {
    await client.$executeRawUnsafe('TRUNCATE TABLE "Tenant" CASCADE');
  });

  // 切断する
  afterAll(async () => {
    await client.$disconnect();
  });

  it('createWithAdmin はテナント・admin・トークンを作り、ハッシュで引くとユーザーも取れる', async () => {
    // 作成
    const created = await makeTenant(repos, 'A');
    expect(created.admin.role).toBe(Role.admin);
    expect(created.admin.tenantId).toBe(created.tenant.id);
    // ハッシュ照合
    const found = await repos.userTokens.findByHash(created.token.tokenHash);
    expect(found?.user.id).toBe(created.admin.id);
    expect(found?.token.id).toBe(created.token.id);
    // 無いハッシュは null
    expect(await repos.userTokens.findByHash('nope')).toBeNull();
  });

  it('ユーザーのメールはテナント内で一意 (DuplicateError)、別テナントなら重複できる', async () => {
    // 2 テナント
    const a = await makeTenant(repos, 'A');
    const b = await makeTenant(repos, 'B');
    // 同テナントで重複
    await expect(
      repos.users.create({
        tenantId: a.tenant.id,
        email: a.admin.email,
        name: 'x',
        role: Role.viewer,
      }),
    ).rejects.toBeInstanceOf(DuplicateError);
    // 別テナントなら可
    const other = await repos.users.create({
      tenantId: b.tenant.id,
      email: a.admin.email,
      name: 'x',
      role: Role.viewer,
    });
    expect(other.tenantId).toBe(b.tenant.id);
  });

  it('エージェントはテナント境界を跨いで見えず、名前はテナント内で一意', async () => {
    // 2 テナントに 1 件ずつ
    const a = await makeTenant(repos, 'A');
    const b = await makeTenant(repos, 'B');
    const agent = await repos.agents.create({
      tenantId: a.tenant.id,
      name: 'bot',
      description: null,
      provider: Provider.anthropic,
      model: 'claude-sonnet-4-6',
      budgetMicroUsd: 123n,
    });
    // 他テナントからは null
    expect(await repos.agents.findById(b.tenant.id, agent.id)).toBeNull();
    expect(await repos.agents.update(b.tenant.id, agent.id, { name: 'x' })).toBeNull();
    expect(await repos.agents.setStatus(b.tenant.id, agent.id, 'stopped')).toBe(null);
    expect(await repos.agents.delete(b.tenant.id, agent.id)).toBe('not_found');
    // 同テナントで名前重複
    await expect(
      repos.agents.create({
        tenantId: a.tenant.id,
        name: 'bot',
        description: null,
        provider: Provider.openai,
        model: 'gpt-5',
        budgetMicroUsd: null,
      }),
    ).rejects.toBeInstanceOf(DuplicateError);
    // BigInt がそのまま戻る
    expect((await repos.agents.findById(a.tenant.id, agent.id))?.budgetMicroUsd).toBe(123n);
  });

  it('API キー・ユーザートークンの複合 FK は別テナントの親を DB で拒否する (null)', async () => {
    // テナント A のエージェント、テナント B のキー発行
    const a = await makeTenant(repos, 'A');
    const b = await makeTenant(repos, 'B');
    const agent = await repos.agents.create({
      tenantId: a.tenant.id,
      name: 'bot',
      description: null,
      provider: Provider.anthropic,
      model: 'm',
      budgetMicroUsd: null,
    });
    // 別テナントのエージェントへ紐づけ → null
    expect(
      await repos.apiKeys.create({
        tenantId: b.tenant.id,
        agentId: agent.id,
        prefix: 'aop_k_x',
        keyHash: 'k1',
        name: 'x',
      }),
    ).toBeNull();
    // 同テナントなら発行できる
    const key = await repos.apiKeys.create({
      tenantId: a.tenant.id,
      agentId: agent.id,
      prefix: 'aop_k_x',
      keyHash: 'k2',
      name: 'x',
    });
    expect(key?.agentId).toBe(agent.id);
    // 別テナントのユーザーへのトークン発行 → null
    expect(
      await repos.userTokens.create({
        tenantId: b.tenant.id,
        userId: a.admin.id,
        prefix: 'aop_u_x',
        tokenHash: 't1',
        name: 'x',
        expiresAt: new Date(Date.now() + DAY_MS),
      }),
    ).toBeNull();
  });

  it('履歴 (UsageEvent) を持つエージェントは削除できず、履歴が無ければ専用キーごと消える', async () => {
    // エージェント + 専用キー
    const a = await makeTenant(repos, 'A');
    const agent = await repos.agents.create({
      tenantId: a.tenant.id,
      name: 'bot',
      description: null,
      provider: Provider.anthropic,
      model: 'm',
      budgetMicroUsd: null,
    });
    const key = await repos.apiKeys.create({
      tenantId: a.tenant.id,
      agentId: agent.id,
      prefix: 'aop_k_x',
      keyHash: 'k3',
      name: 'x',
    });
    // 利用イベントを 1 件入れる (Restrict)
    await client.usageEvent.create({
      data: {
        tenantId: a.tenant.id,
        agentId: agent.id,
        provider: Provider.anthropic,
        model: 'm',
        inputTokens: 1,
        outputTokens: 1,
        costMicroUsd: 1n,
        latencyMs: 1,
        statusCode: 200,
      },
    });
    // 削除は拒否される
    expect(await repos.agents.delete(a.tenant.id, agent.id)).toBe('restricted');
    // 履歴を消してから削除すると、専用キーも Cascade で消える
    await client.usageEvent.deleteMany({ where: { agentId: agent.id } });
    expect(await repos.agents.delete(a.tenant.id, agent.id)).toBe('deleted');
    expect(await repos.apiKeys.findById(a.tenant.id, key!.id)).toBeNull();
  });

  it('一覧は createdAt → id 順で、カーソルで続きが取れ、存在しないカーソルは空', async () => {
    // 3 件
    const a = await makeTenant(repos, 'A');
    for (const name of ['x', 'y', 'z']) {
      await repos.agents.create({
        tenantId: a.tenant.id,
        name,
        description: null,
        provider: Provider.anthropic,
        model: 'm',
        budgetMicroUsd: null,
      });
    }
    // 2 件ずつ
    const p1 = await repos.agents.list(a.tenant.id, { limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBe(p1.items[1].id);
    const p2 = await repos.agents.list(a.tenant.id, { limit: 2, cursor: p1.nextCursor });
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeUndefined();
    // 重複無し・作成順
    const names = [...p1.items, ...p2.items].map((r) => r.name);
    expect(names).toEqual(['x', 'y', 'z']);
    // 未知のカーソル
    expect((await repos.agents.list(a.tenant.id, { limit: 2, cursor: 'nope' })).items).toHaveLength(
      0,
    );
  });

  it('無効化は冪等で、有効な admin の人数は無効化を反映する', async () => {
    // admin 1 人
    const a = await makeTenant(repos, 'A');
    expect(await repos.users.countActiveAdmins(a.tenant.id)).toBe(1);
    // 2 人目の admin を無効化
    const second = await repos.users.create({
      tenantId: a.tenant.id,
      email: 'second@example.com',
      name: '2',
      role: Role.admin,
    });
    expect(await repos.users.countActiveAdmins(a.tenant.id)).toBe(2);
    const once = await repos.users.disable(a.tenant.id, second.id);
    const twice = await repos.users.disable(a.tenant.id, second.id);
    expect(once?.disabledAt).not.toBeNull();
    expect(twice?.disabledAt?.getTime()).toBe(once?.disabledAt?.getTime());
    expect(await repos.users.countActiveAdmins(a.tenant.id)).toBe(1);
    // 他テナントからは触れない
    expect(await repos.users.disable('other', second.id)).toBeNull();
  });
});
