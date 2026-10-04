// エージェント Port のうち、API からは一度も呼ばれない操作を memory 側でも固定する。
//
// **ADR-0006 の死角への手当て。** `findNamesByIds` は画面（インシデント一覧）しか呼ばないので、
// API テストの経路を 1 行も通らない。memory 側が prisma より緩い（他テナントの名前を返す・
// 要求していない id まで返す）と、画面のテストも契約テストも緑のまま本番だけ違う挙動になる。
// 同じ期待を `tests/data/repositories.contract.prisma.test.ts` にも書く（ここは意図的に対にする）。
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryRepos, MemoryStore } from '@/data/adapters/memory';
import type { Repositories } from '@/data/ports';
import { Provider } from '@/domain/types';

// テナントを 1 つ作る（名前だけ変えて 2 つ作れるようにする）
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

// そのテナントにエージェントを 1 件作って id を返す
async function makeAgent(repos: Repositories, tenantId: string, name: string): Promise<string> {
  // 最小限の入力で作る
  const agent = await repos.agents.create({
    tenantId,
    name,
    description: null,
    provider: Provider.anthropic,
    model: 'claude-sonnet-4-6',
    budgetMicroUsd: null,
  });
  return agent.id;
}

describe('memory アダプタ: エージェント名のまとめ取得', () => {
  // 表とリポジトリ（テストごとに作り直す）
  let repos: Repositories;

  beforeEach(() => {
    // 新しい表で組み立てる
    repos = createMemoryRepos(new MemoryStore());
  });

  it('要求した id だけを id → 名前 の表で返す', async () => {
    // 同じテナントに 3 件
    const tenantId = await makeTenant(repos, 'A');
    const first = await makeAgent(repos, tenantId, '要約ボット');
    const second = await makeAgent(repos, tenantId, '分類ボット');
    await makeAgent(repos, tenantId, '呼ばれないボット');
    // 2 件だけ要求する
    const names = await repos.agents.findNamesByIds(tenantId, [first, second]);
    // 要求した 2 件が名前で引ける
    expect(names.get(first)).toBe('要約ボット');
    expect(names.get(second)).toBe('分類ボット');
    // 要求していない行は入らない（画面が出す以上の情報を渡さない）
    expect(names.size).toBe(2);
  });

  it('他テナントの id は結果に現れない', async () => {
    // 2 テナントに 1 件ずつ
    const a = await makeTenant(repos, 'A');
    const b = await makeTenant(repos, 'B');
    const mine = await makeAgent(repos, a, '自テナント');
    const theirs = await makeAgent(repos, b, '他テナント');
    // 他テナントの id を混ぜて要求する
    const names = await repos.agents.findNamesByIds(a, [mine, theirs]);
    // 自分のものだけが返る（混ぜた id は存在ごと隠れる。ADR-0002）
    expect([...names.keys()]).toEqual([mine]);
  });

  it('存在しない id と空の要求は静かに空で返す', async () => {
    // 1 テナントだけ
    const tenantId = await makeTenant(repos, 'A');
    // 存在しない id
    expect((await repos.agents.findNamesByIds(tenantId, ['agent_missing'])).size).toBe(0);
    // 空の要求（インシデントが 1 件も無い画面）
    expect((await repos.agents.findNamesByIds(tenantId, [])).size).toBe(0);
  });

  it('同じ id を重ねて要求しても 1 件として返る', async () => {
    // 1 件だけ作る
    const tenantId = await makeTenant(repos, 'A');
    const agentId = await makeAgent(repos, tenantId, '要約ボット');
    // 同じエージェントが複数のインシデントを起こした形（画面は id を重ねて渡す）
    const names = await repos.agents.findNamesByIds(tenantId, [agentId, agentId, agentId]);
    expect(names.size).toBe(1);
  });
});
