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
import { GET as getMetrics } from '@/app/api/v1/metrics/route';
import { GET as listTenants, POST as createTenant } from '@/app/api/v1/tenants/route';
import { GET as getTenant, PATCH as updateTenantPlan } from '@/app/api/v1/tenants/[tenantId]/route';
import { GET as listUsers, POST as createUser } from '@/app/api/v1/users/route';
import { DELETE as disableUser } from '@/app/api/v1/users/[userId]/route';
import { PUT as updateUserRole } from '@/app/api/v1/users/[userId]/role/route';
import {
  GET as listUserTokens,
  POST as createUserToken,
} from '@/app/api/v1/users/[userId]/tokens/route';
import { DELETE as revokeUserToken } from '@/app/api/v1/users/[userId]/tokens/[tokenId]/route';
import { POST as proxyAnthropic } from '@/app/api/v1/proxy/anthropic/messages/route';
import { POST as proxyOpenAi } from '@/app/api/v1/proxy/openai/chat/completions/route';
import { GET as getDailyUsage } from '@/app/api/v1/usage/daily/route';
import {
  GET as listEvaluationSets,
  POST as createEvaluationSet,
} from '@/app/api/v1/evaluation-sets/route';
import { GET as getEvaluationSet } from '@/app/api/v1/evaluation-sets/[setId]/route';
import { GET as listEvaluationRuns, POST as runEvaluation } from '@/app/api/v1/evaluations/route';
import { GET as getEvaluationRun } from '@/app/api/v1/evaluations/[runId]/route';
import {
  GET as listGuardrailRules,
  POST as createGuardrailRule,
} from '@/app/api/v1/guardrails/route';
import {
  DELETE as deleteGuardrailRule,
  PATCH as updateGuardrailRule,
} from '@/app/api/v1/guardrails/[ruleId]/route';
import { POST as runGuardrails } from '@/app/api/v1/guardrails/run/route';
import { GET as listIncidents } from '@/app/api/v1/incidents/route';
import { POST as resolveIncident } from '@/app/api/v1/incidents/[incidentId]/resolve/route';
import { GET as listAuditLogs } from '@/app/api/v1/audit-logs/route';
import { GET as getBilling } from '@/app/api/v1/billing/route';
import { GET as verifyAuditLogs } from '@/app/api/v1/audit-logs/verify/route';
import { POST as runMaintenance } from '@/app/api/v1/maintenance/run/route';
import { canPerform, type Action } from '@/domain/rbac';
import { Plan, Role } from '@/domain/types';
import { call, PLATFORM_TOKEN, seedEachTest } from './helpers';

// seed (各テストで作り直し、後始末も helpers が行う)
const seed = seedEachTest();

// そのオペレーションを呼ぶのに要る権限。
//   - Action: 許可表 (src/domain/rbac.ts) の view / execute / stop
//   - 'admin': 役割そのものが admin であること (ユーザー管理・トークン管理)
//   - 'platform': プラットフォーム管理者トークン (テナントの外側。テナント内の役割はすべて 403)
//   - 'apiKey': プロキシ専用。API キー (aop_k_...) でしか呼べず、ユーザートークンは**認証の段階で**弾かれる
//   - 'metricsToken': 監視専用。読み取り専用の環境変数トークンでしか呼べず、ユーザートークンも
//     プラットフォーム管理者トークンも**認証の段階で**弾かれる (§9 最小権限。ADR-0014)
type Requirement = Action | 'admin' | 'platform' | 'apiKey' | 'metricsToken';

// 権限を満たさない資格情報で呼んだときに返るべきステータス。
// プロキシだけ 401 なのは、ユーザートークンが「権限が足りない」のではなく
// 「この経路では資格情報として受け付けない」ため (ADR-0007)。403 を期待すると、
// 認証を緩めて認可で弾く形へ変えたときに気付けない
function deniedStatus(requirement: Requirement): number {
  // プロキシ経路と監視経路は認証で弾く (資格情報の種類が違うので 403 ではない)
  return requirement === 'apiKey' || requirement === 'metricsToken' ? 401 : 403;
}

// 契約の operationId → 「要る権限」と「呼び方」。
// 本文・パラメータは 403 の判定に関係しないので最小限にする (認可は本文検証より前に走る)
const ENDPOINTS: Record<
  string,
  { requires: Requirement; invoke: (token: string) => Promise<number> }
> = {
  getMetrics: {
    requires: 'metricsToken',
    invoke: async (t) => (await call(getMetrics, { token: t })).status,
  },
  listTenants: {
    requires: 'platform',
    invoke: async (t) => (await call(listTenants, { token: t })).status,
  },
  createTenant: {
    requires: 'platform',
    invoke: async (t) => (await call(createTenant, { token: t, body: {} })).status,
  },
  runMaintenance: {
    requires: 'platform',
    invoke: async (t) =>
      (await call(runMaintenance, { method: 'POST', token: t, body: {} })).status,
  },
  getTenant: {
    requires: 'view',
    invoke: async (t) =>
      (await call(getTenant, { token: t, params: { tenantId: seed.a.id } })).status,
  },
  updateTenantPlan: {
    requires: 'platform',
    invoke: async (t) =>
      (
        await call(updateTenantPlan, {
          method: 'PATCH',
          token: t,
          params: { tenantId: seed.a.id },
          body: { plan: Plan.pro },
        })
      ).status,
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
  proxyAnthropicMessages: {
    requires: 'apiKey',
    invoke: async (t) => (await call(proxyAnthropic, { token: t, body: {} })).status,
  },
  proxyOpenAiChatCompletions: {
    requires: 'apiKey',
    invoke: async (t) => (await call(proxyOpenAi, { token: t, body: {} })).status,
  },
  getDailyUsage: {
    requires: 'view',
    invoke: async (t) =>
      (await call(getDailyUsage, { token: t, query: 'from=2026-01-01&to=2026-01-31' })).status,
  },
  listEvaluationSets: {
    requires: 'view',
    invoke: async (t) => (await call(listEvaluationSets, { token: t })).status,
  },
  createEvaluationSet: {
    requires: 'execute',
    invoke: async (t) => (await call(createEvaluationSet, { token: t, body: {} })).status,
  },
  getEvaluationSet: {
    requires: 'view',
    invoke: async (t) =>
      (await call(getEvaluationSet, { token: t, params: { setId: seed.a.id } })).status,
  },
  listEvaluationRuns: {
    requires: 'view',
    invoke: async (t) => (await call(listEvaluationRuns, { token: t })).status,
  },
  runEvaluation: {
    requires: 'execute',
    invoke: async (t) => (await call(runEvaluation, { token: t, body: {} })).status,
  },
  getEvaluationRun: {
    requires: 'view',
    invoke: async (t) =>
      (await call(getEvaluationRun, { token: t, params: { runId: seed.a.id } })).status,
  },
  listGuardrailRules: {
    requires: 'view',
    invoke: async (t) => (await call(listGuardrailRules, { token: t })).status,
  },
  createGuardrailRule: {
    requires: 'admin',
    invoke: async (t) => (await call(createGuardrailRule, { token: t, body: {} })).status,
  },
  updateGuardrailRule: {
    requires: 'admin',
    invoke: async (t) =>
      (
        await call(updateGuardrailRule, {
          token: t,
          method: 'PATCH',
          params: { ruleId: 'missing' },
          body: { enabled: false },
        })
      ).status,
  },
  deleteGuardrailRule: {
    requires: 'admin',
    invoke: async (t) =>
      (
        await call(deleteGuardrailRule, {
          token: t,
          method: 'DELETE',
          params: { ruleId: 'missing' },
        })
      ).status,
  },
  runGuardrails: {
    requires: 'stop',
    invoke: async (t) => (await call(runGuardrails, { token: t, body: {} })).status,
  },
  listIncidents: {
    requires: 'view',
    invoke: async (t) => (await call(listIncidents, { token: t })).status,
  },
  resolveIncident: {
    requires: 'admin',
    invoke: async (t) =>
      (await call(resolveIncident, { token: t, params: { incidentId: 'missing' } })).status,
  },
  listAuditLogs: {
    requires: 'view',
    invoke: async (t) => (await call(listAuditLogs, { token: t })).status,
  },
  getBilling: {
    requires: 'view',
    invoke: async (t) => (await call(getBilling, { token: t })).status,
  },
  verifyAuditLogs: {
    requires: 'admin',
    invoke: async (t) => (await call(verifyAuditLogs, { token: t })).status,
  },
};

// 認証が要らない公開オペレーション (表に載せない理由付きの唯一の除外)
const PUBLIC_OPERATIONS: Record<string, string> = {
  getHealth: 'DB 到達性だけを返す公開エンドポイント (compose の healthcheck が使う)',
  // **役割では守らない経路**（Step6）。呼ぶのは課金事業者で、認証は署名で行う。
  // 署名を通ることは `tests/route-wrapping.test.ts` が import の連鎖から要求し、
  // 署名そのものの挙動は `tests/billing-signature.test.ts` と `tests/api/billing.test.ts` が固定する
  receiveBillingWebhook:
    '課金事業者 (Stripe) が呼ぶ受信 Webhook。Bearer 認証ではなく Stripe-Signature の' +
    'HMAC-SHA256 署名で認証するので、テナント内の役割では守らない',
};

// その役割がそのオペレーションを呼べるか
function allows(requirement: Requirement, role: Role): boolean {
  // プロキシ専用・監視専用の経路はどの役割のユーザートークンでも呼べない
  if (requirement === 'apiKey' || requirement === 'metricsToken') return false;
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
      it(`${operationId} は ${role} が呼ぶと ${deniedStatus(endpoint.requires)}`, async () => {
        // その役割のトークンで呼ぶ
        const status = await endpoint.invoke(seed.a.tokens[role]);
        // 権限不足は 403 / 資格情報の種類違いは 401
        // (404 や 422 に化けていないこと = 認証・認可が本文検証より前にあることも同時に見る)
        expect(status).toBe(deniedStatus(endpoint.requires));
      });
    }
    // プラットフォーム管理者はテナントの外側の主体なので、テナント内の資源には一切触れない。
    // 役割だけを回していると、この不変条件を担う 1 行 (requireTenantUser) を requireAdminRole の
    // 経路で素通しにしても全件緑のまま通る (実測。ユーザー招待とトークン発行が通った)
    if (endpoint.requires !== 'platform') {
      it(`${operationId} はプラットフォーム管理者が呼ぶと ${deniedStatus(endpoint.requires)}`, async () => {
        // プラットフォーム管理者トークンで呼ぶ
        const status = await endpoint.invoke(PLATFORM_TOKEN);
        // テナント内の資源なので 403 (プロキシ・監視の経路は資格情報の種類が違うので 401)。
        // **監視の経路でこれが要る理由**: あの資格情報はテナント作成 (応答に新しいテナントの
        // admin トークンの平文が載る) とプラン変更も通るので、収集エージェントへ配らない。
        // 配れる値にしてしまう変更 (認証を platform へ戻す) はここで落ちる
        expect(status).toBe(deniedStatus(endpoint.requires));
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
