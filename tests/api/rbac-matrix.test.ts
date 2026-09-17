// Step1 の受け入れ基準「権限違反テスト全パターン (役割 3 × 操作 3) で 403」を API 経路で固定する。
// テスト名の「RBAC 行列: <役割> × <操作>」は scripts/gate-step1.mjs が 9 パターンの存在を照合するので変えない
import { beforeEach, describe, expect, it } from 'vitest';
import { GET as listAgents, POST as createAgent } from '@/app/api/v1/agents/route';
import { POST as stopAgent } from '@/app/api/v1/agents/[agentId]/stop/route';
import { POST as createUser } from '@/app/api/v1/users/route';
import { GET as listTenants } from '@/app/api/v1/tenants/route';
import { ACTIONS, canPerform, type Action } from '@/domain/rbac';
import { Provider, Role } from '@/domain/types';
import { call, PLATFORM_TOKEN, setupSeed, type Seed } from './helpers';

// seed (各テストで作り直す)
let seed: Seed;
beforeEach(() => {
  seed = setupSeed();
});

// 操作ごとに「その操作を要求する代表エンドポイント」を 1 つ決める
const ENDPOINT_BY_ACTION: Record<Action, (token: string) => Promise<number>> = {
  // view: エージェント一覧
  view: async (token) => (await call(listAgents, { token })).status,
  // execute: エージェント登録
  execute: async (token) =>
    (
      await call(createAgent, {
        token,
        body: { name: 'RBAC 検証', provider: Provider.openai, model: 'gpt-5' },
      })
    ).status,
  // stop: エージェント停止
  stop: async (token) =>
    (
      await call(stopAgent, {
        token,
        method: 'POST',
        params: { agentId: seed.a.agent.id },
      })
    ).status,
};

describe('RBAC 行列 (役割 3 × 操作 3)', () => {
  // 期待値は許可表そのものから導く (表とテストで写しを持たない。表の内容は tests/rbac.test.ts が固定する)
  for (const role of Object.values(Role)) {
    for (const action of ACTIONS) {
      // 許可なら 2xx、不許可なら 403
      const allowed = canPerform(role, action);
      it(`RBAC 行列: ${role} × ${action} → ${allowed ? '許可 (2xx)' : '403'}`, async () => {
        // その役割のトークンで代表エンドポイントを呼ぶ
        const status = await ENDPOINT_BY_ACTION[action](seed.a.tokens[role]);
        // 許可なら成功系、不許可なら 403 であること
        if (allowed) expect(status).toBeGreaterThanOrEqual(200);
        if (allowed) expect(status).toBeLessThan(300);
        else expect(status).toBe(403);
      });
    }
  }
});

describe('RBAC の表の外側にある権限語彙', () => {
  it('admin ロール限定の操作 (ユーザー招待) は viewer / operator が呼ぶと 403', async () => {
    // 招待の本文
    const body = { email: 'new@example.com', name: '新人', role: Role.viewer };
    // viewer と operator は 403
    for (const role of [Role.viewer, Role.operator]) {
      expect((await call(createUser, { token: seed.a.tokens[role], body })).status).toBe(403);
    }
    // admin は 201
    expect((await call(createUser, { token: seed.a.tokens.admin, body })).status).toBe(201);
  });

  it('プラットフォーム管理者トークンはテナント内の資源 (エージェント一覧) に触れず 403', async () => {
    // テナント境界の外側なので、閲覧すら許さない
    expect((await call(listAgents, { token: PLATFORM_TOKEN })).status).toBe(403);
  });

  it('テナントの admin でもテナント一覧は 403 (プラットフォーム管理者専用)', async () => {
    // 他テナントの存在を知る手段を与えない
    expect((await call(listTenants, { token: seed.a.tokens.admin })).status).toBe(403);
  });
});
