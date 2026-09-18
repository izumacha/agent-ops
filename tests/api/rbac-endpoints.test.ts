// 認可の網を「代表エンドポイント 1 本ずつ」から「契約に載る全オペレーション」へ広げる。
// RBAC 行列 (tests/api/rbac-matrix.test.ts) は操作ごとに代表 1 本しか呼ばないので、
// たとえば DELETE /agents/{agentId} の要求権限を stop から view へ緩めても全件緑のまま通っていた
// (= viewer がエージェントを消せる状態が検出されない)。ここでは「拒否されるべき役割は 403」を全経路で固定する。
// 認可はハンドラの冒頭 (本文を読む前) に走るので、本文が無くても 403 は決まる — だから呼び出しは最小限でよい
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { GET as listAgents, POST as createAgent } from '@/app/api/v1/agents/route';
import {
  DELETE as deleteAgent,
  GET as getAgent,
  PATCH as updateAgent,
} from '@/app/api/v1/agents/[agentId]/route';
import { POST as resumeAgent } from '@/app/api/v1/agents/[agentId]/resume/route';
import { POST as stopAgent } from '@/app/api/v1/agents/[agentId]/stop/route';
import { GET as listApiKeys, POST as createApiKey } from '@/app/api/v1/api-keys/route';
import { DELETE as revokeApiKey } from '@/app/api/v1/api-keys/[apiKeyId]/route';
import { GET as getMe } from '@/app/api/v1/me/route';
import { GET as listTenants, POST as createTenant } from '@/app/api/v1/tenants/route';
import { GET as getTenant } from '@/app/api/v1/tenants/[tenantId]/route';
import { GET as listUsers, POST as createUser } from '@/app/api/v1/users/route';
import { DELETE as disableUser } from '@/app/api/v1/users/[userId]/route';
import { PUT as updateUserRole } from '@/app/api/v1/users/[userId]/role/route';
import {
  GET as listUserTokens,
  POST as createUserToken,
} from '@/app/api/v1/users/[userId]/tokens/route';
import { DELETE as revokeUserToken } from '@/app/api/v1/users/[userId]/tokens/[tokenId]/route';
import { canPerform, type Action } from '@/domain/rbac';
import { Role } from '@/domain/types';
import { call, seedEachTest } from './helpers';

// seed (各テストで作り直し、後始末も helpers が行う)
const seed = seedEachTest();

// そのオペレーションを呼ぶのに要る権限。
//   - Action: 許可表 (src/domain/rbac.ts) の view / execute / stop
//   - 'admin': 役割そのものが admin であること (ユーザー管理・トークン管理)
//   - 'platform': プラットフォーム管理者トークン (テナントの外側。テナント内の役割はすべて 403)
type Requirement = Action | 'admin' | 'platform';

// 契約の operationId → 「要る権限」と「呼び方」。
// 本文・パラメータは 403 の判定に関係しないので最小限にする (認可は本文検証より前に走る)
const ENDPOINTS: Record<
  string,
  { requires: Requirement; invoke: (token: string) => Promise<number> }
> = {
  listTenants: {
    requires: 'platform',
    invoke: async (t) => (await call(listTenants, { token: t })).status,
  },
  createTenant: {
    requires: 'platform',
    invoke: async (t) => (await call(createTenant, { token: t, body: {} })).status,
  },
  getTenant: {
    requires: 'view',
    invoke: async (t) =>
      (await call(getTenant, { token: t, params: { tenantId: seed.a.id } })).status,
  },
  getMe: { requires: 'view', invoke: async (t) => (await call(getMe, { token: t })).status },
  listUsers: {
    requires: 'view',
    invoke: async (t) => (await call(listUsers, { token: t })).status,
  },
  createUser: {
    requires: 'admin',
    invoke: async (t) => (await call(createUser, { token: t, body: {} })).status,
  },
  disableUser: {
    requires: 'admin',
    invoke: async (t) =>
      (
        await call(disableUser, {
          token: t,
          method: 'DELETE',
          params: { userId: seed.a.users.viewer.id },
        })
      ).status,
  },
  updateUserRole: {
    requires: 'admin',
    invoke: async (t) =>
      (
        await call(updateUserRole, {
          token: t,
          method: 'PUT',
          params: { userId: seed.a.users.viewer.id },
          body: {},
        })
      ).status,
  },
  listUserTokens: {
    requires: 'admin',
    invoke: async (t) =>
      (await call(listUserTokens, { token: t, params: { userId: seed.a.users.admin.id } })).status,
  },
  createUserToken: {
    requires: 'admin',
    invoke: async (t) =>
      (
        await call(createUserToken, {
          token: t,
          params: { userId: seed.a.users.admin.id },
          body: {},
        })
      ).status,
  },
  revokeUserToken: {
    requires: 'admin',
    invoke: async (t) =>
      (
        await call(revokeUserToken, {
          token: t,
          method: 'DELETE',
          params: { userId: seed.a.users.admin.id, tokenId: seed.a.tokenRows.admin.id },
        })
      ).status,
  },
  listAgents: {
    requires: 'view',
    invoke: async (t) => (await call(listAgents, { token: t })).status,
  },
  createAgent: {
    requires: 'execute',
    invoke: async (t) => (await call(createAgent, { token: t, body: {} })).status,
  },
  getAgent: {
    requires: 'view',
    invoke: async (t) =>
      (await call(getAgent, { token: t, params: { agentId: seed.a.agent.id } })).status,
  },
  updateAgent: {
    requires: 'execute',
    invoke: async (t) =>
      (
        await call(updateAgent, {
          token: t,
          method: 'PATCH',
          params: { agentId: seed.a.agent.id },
          body: {},
        })
      ).status,
  },
  deleteAgent: {
    requires: 'stop',
    invoke: async (t) =>
      (
        await call(deleteAgent, {
          token: t,
          method: 'DELETE',
          params: { agentId: seed.a.agent.id },
        })
      ).status,
  },
  stopAgent: {
    requires: 'stop',
    invoke: async (t) =>
      (await call(stopAgent, { token: t, method: 'POST', params: { agentId: seed.a.agent.id } }))
        .status,
  },
  resumeAgent: {
    requires: 'stop',
    invoke: async (t) =>
      (await call(resumeAgent, { token: t, method: 'POST', params: { agentId: seed.a.agent.id } }))
        .status,
  },
  listApiKeys: {
    requires: 'view',
    invoke: async (t) => (await call(listApiKeys, { token: t })).status,
  },
  createApiKey: {
    requires: 'execute',
    invoke: async (t) => (await call(createApiKey, { token: t, body: {} })).status,
  },
  revokeApiKey: {
    requires: 'stop',
    invoke: async (t) =>
      (
        await call(revokeApiKey, {
          token: t,
          method: 'DELETE',
          params: { apiKeyId: 'missing' },
        })
      ).status,
  },
};

// 認証が要らない公開オペレーション (表に載せない理由付きの唯一の除外)
const PUBLIC_OPERATIONS: Record<string, string> = {
  getHealth: 'DB 到達性だけを返す公開エンドポイント (compose の healthcheck が使う)',
};

// その役割がそのオペレーションを呼べるか
function allows(requirement: Requirement, role: Role): boolean {
  // プラットフォーム管理者専用はテナント内の役割では呼べない
  if (requirement === 'platform') return false;
  // admin 限定は役割そのものを見る
  if (requirement === 'admin') return role === Role.admin;
  // それ以外は許可表に従う
  return canPerform(role, requirement);
}

describe('全オペレーションの認可', () => {
  // 拒否されるべき役割は必ず 403 になること
  for (const [operationId, endpoint] of Object.entries(ENDPOINTS)) {
    for (const role of Object.values(Role)) {
      // 呼べる役割はここでは見ない (成功系は各 API テストが固定する)
      if (allows(endpoint.requires, role)) continue;
      it(`${operationId} は ${role} が呼ぶと 403`, async () => {
        // その役割のトークンで呼ぶ
        const status = await endpoint.invoke(seed.a.tokens[role]);
        // 権限不足は 403 (404 や 422 に化けていないこと = 認可が本文検証より前にあることも同時に見る)
        expect(status).toBe(403);
      });
    }
  }

  // 表に載せ忘れたオペレーションは検査から静かに外れるので、契約側から網羅を照合する
  it('契約に載る全オペレーションが表にある (公開エンドポイントを除く)', () => {
    // 契約を読む
    const spec = parse(readFileSync(join(process.cwd(), 'openapi', 'openapi.yaml'), 'utf8')) as {
      paths: Record<string, Record<string, { operationId?: string } | undefined>>;
    };
    // 契約に載る operationId
    const declared = Object.values(spec.paths).flatMap((item) =>
      Object.values(item).flatMap((op) => (op?.operationId ? [op.operationId] : [])),
    );
    // 1 つも読めなければ走査が壊れている (fail-closed)
    expect(declared.length).toBeGreaterThan(0);
    // 表か「公開」のどちらかに必ず載っていること
    for (const operationId of declared) {
      expect(
        operationId in ENDPOINTS || operationId in PUBLIC_OPERATIONS,
        `${operationId} が認可の表に無い`,
      ).toBe(true);
    }
  });
});
