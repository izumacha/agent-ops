// テナント越境アクセス（Step6 の受け入れ基準①「全パターンで拒否」）。
//
// **「全パターン」を契約（openapi.yaml）から導く。** 対象は「URL にテナント内の資源の id を
// 含むオペレーション」すべてで、各々に `越境: <METHOD> <path>` という名前のテストが要る
// （`scripts/gate-step6.mjs` がこの名前で照合する。料金表・RBAC 行列と同じ流儀）。
//
// **手書きの一覧にしない。** 一覧だと、`[id]` を持つルートを新しく足した人が追記を忘れた
// ぶんだけ網が静かに狭まる（この repo が繰り返し避けている形）。下の表は契約から導いた集合と
// **双方向で**突き合わせるので、契約にあって表に無いものも、表にあって契約に無いものも落ちる。
//
// **期待する応答は 404。** 403 だと「その id は存在する」ことが漏れる（ADR-0002）。
// 呼ぶのは**自テナントの admin**（権限は足りているので、拒否の理由がテナント境界だけになる）。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  DELETE as deleteAgent,
  GET as getAgent,
  PATCH as updateAgent,
} from '@/app/api/v1/agents/[agentId]/route';
import { POST as resumeAgent } from '@/app/api/v1/agents/[agentId]/resume/route';
import { POST as stopAgent } from '@/app/api/v1/agents/[agentId]/stop/route';
import { DELETE as revokeApiKey } from '@/app/api/v1/api-keys/[apiKeyId]/route';
import { GET as getTenant } from '@/app/api/v1/tenants/[tenantId]/route';
import { DELETE as disableUser } from '@/app/api/v1/users/[userId]/route';
import { PUT as updateUserRole } from '@/app/api/v1/users/[userId]/role/route';
import {
  GET as listUserTokens,
  POST as createUserToken,
} from '@/app/api/v1/users/[userId]/tokens/route';
import { DELETE as revokeUserToken } from '@/app/api/v1/users/[userId]/tokens/[tokenId]/route';
import { GET as getEvaluationSet } from '@/app/api/v1/evaluation-sets/[setId]/route';
import { GET as getEvaluationRun } from '@/app/api/v1/evaluations/[runId]/route';
import {
  DELETE as deleteGuardrailRule,
  PATCH as updateGuardrailRule,
} from '@/app/api/v1/guardrails/[ruleId]/route';
import { POST as resolveIncident } from '@/app/api/v1/incidents/[incidentId]/resolve/route';
import { EvaluationRunStatus, Provider, Role, RuleAction, RuleKind } from '@/domain/types';
import { call, seedApiKey, seedEachTest, type Seed } from './helpers';
import { TEST_GUARDRAIL_RULE_LIMITS } from '../lib/guardrail-limits';

// seed（各テストで作り直す）
const seed = seedEachTest();

// 越境の相手（テナント B）に用意した資源の id
interface ForeignIds {
  tenantId: string;
  userId: string;
  tokenId: string;
  agentId: string;
  apiKeyId: string;
  setId: string;
  runId: string;
  ruleId: string;
  incidentId: string;
}

// テナント B 側の資源を用意する（各テストの中で呼ぶ。memory の表へ直接 seed する経路も使う）
async function seedForeign(current: Seed): Promise<ForeignIds> {
  // B の admin とそのトークン行（helpers が seed 済み）
  const user = current.b.users[Role.admin];
  const tokenRow = current.b.tokenRows[Role.admin];
  // B のエージェント（helpers が seed 済み）
  const agent = current.b.agent;
  // B の API キー
  const key = seedApiKey(current, { tenantId: current.b.id, agentId: agent.id });
  // B の評価セット（1 ケースだけ）
  const set = await current.repos.evaluations.createSet({
    tenantId: current.b.id,
    name: '越境用セット',
    cases: [{ input: '入力', expected: '期待' }],
  });
  // B の評価実行（採点 0 件の実行でよい。参照できるかだけを見る）
  const run = await current.repos.evaluations.createRun({
    tenantId: current.b.id,
    setId: set.set.id,
    agentId: agent.id,
    accuracy: null,
    safety: null,
    deviation: null,
    status: EvaluationRunStatus.completed,
    scoredCases: 0,
    excludedCases: 1,
    judgeProvider: Provider.anthropic,
    judgeModel: 'claude-sonnet-4-6',
    results: [],
  });
  if (run === null) throw new Error('評価実行を作れません');
  // B のガードレールのルール
  const rule = await current.repos.guardrailRules.create(
    {
      tenantId: current.b.id,
      agentId: agent.id,
      kind: RuleKind.cost,
      threshold: 1_000,
      windowMinutes: 60,
      action: RuleAction.notify,
    },
    TEST_GUARDRAIL_RULE_LIMITS,
  );
  if (rule.status !== 'created') throw new Error(`ルールを作れません: ${rule.status}`);
  // B のインシデント（解決の越境を試すため未解決で作る）
  const incident = await current.repos.incidents.raise({
    tenantId: current.b.id,
    agentId: agent.id,
    ruleId: rule.rule.id,
    summary: '越境用インシデント',
    suspendAgent: false,
  });
  if (incident === null) throw new Error('インシデントを作れません');
  // まとめて返す
  return {
    tenantId: current.b.id,
    userId: user.id,
    tokenId: tokenRow.id,
    agentId: agent.id,
    apiKeyId: key.row.id,
    setId: set.set.id,
    runId: run.run.id,
    ruleId: rule.rule.id,
    incidentId: incident.incident.id,
  };
}

// 1 パターンの呼び出し（自テナントの admin のトークンで、B の id を指す）
type Invoke = (token: string, ids: ForeignIds) => Promise<number>;

/**
 * 契約の「URL にテナント内の資源の id を含むオペレーション」→ 呼び出し の表。
 *
 * キーは `<METHOD> <path>`（契約の綴りそのまま）。**契約から導いた集合と双方向で照合する**ので、
 * ルートを足して登録を忘れたら落ち、消えたルートの登録が残っていても落ちる。
 */
const CROSS_TENANT_CASES: Record<string, Invoke> = {
  'GET /tenants/{tenantId}': async (token, ids) =>
    (await call(getTenant, { token, params: { tenantId: ids.tenantId } })).status,
  'DELETE /users/{userId}': async (token, ids) =>
    (await call(disableUser, { method: 'DELETE', token, params: { userId: ids.userId } })).status,
  'PUT /users/{userId}/role': async (token, ids) =>
    (
      await call(updateUserRole, {
        method: 'PUT',
        token,
        params: { userId: ids.userId },
        body: { role: Role.viewer },
      })
    ).status,
  'GET /users/{userId}/tokens': async (token, ids) =>
    (await call(listUserTokens, { token, params: { userId: ids.userId } })).status,
  'POST /users/{userId}/tokens': async (token, ids) =>
    (
      await call(createUserToken, {
        token,
        params: { userId: ids.userId },
        body: { name: '越境トークン' },
      })
    ).status,
  'DELETE /users/{userId}/tokens/{tokenId}': async (token, ids) =>
    (
      await call(revokeUserToken, {
        method: 'DELETE',
        token,
        params: { userId: ids.userId, tokenId: ids.tokenId },
      })
    ).status,
  'GET /agents/{agentId}': async (token, ids) =>
    (await call(getAgent, { token, params: { agentId: ids.agentId } })).status,
  'PATCH /agents/{agentId}': async (token, ids) =>
    (
      await call(updateAgent, {
        method: 'PATCH',
        token,
        params: { agentId: ids.agentId },
        body: { name: '越境で改名' },
      })
    ).status,
  'DELETE /agents/{agentId}': async (token, ids) =>
    (await call(deleteAgent, { method: 'DELETE', token, params: { agentId: ids.agentId } })).status,
  'POST /agents/{agentId}/stop': async (token, ids) =>
    (await call(stopAgent, { token, params: { agentId: ids.agentId }, body: {} })).status,
  'POST /agents/{agentId}/resume': async (token, ids) =>
    (await call(resumeAgent, { token, params: { agentId: ids.agentId }, body: {} })).status,
  'DELETE /api-keys/{apiKeyId}': async (token, ids) =>
    (await call(revokeApiKey, { method: 'DELETE', token, params: { apiKeyId: ids.apiKeyId } }))
      .status,
  'GET /evaluation-sets/{setId}': async (token, ids) =>
    (await call(getEvaluationSet, { token, params: { setId: ids.setId } })).status,
  'GET /evaluations/{runId}': async (token, ids) =>
    (await call(getEvaluationRun, { token, params: { runId: ids.runId } })).status,
  'PATCH /guardrails/{ruleId}': async (token, ids) =>
    (
      await call(updateGuardrailRule, {
        method: 'PATCH',
        token,
        params: { ruleId: ids.ruleId },
        body: { enabled: false },
      })
    ).status,
  'DELETE /guardrails/{ruleId}': async (token, ids) =>
    (
      await call(deleteGuardrailRule, {
        method: 'DELETE',
        token,
        params: { ruleId: ids.ruleId },
      })
    ).status,
  'POST /incidents/{incidentId}/resolve': async (token, ids) =>
    (
      await call(resolveIncident, {
        token,
        params: { incidentId: ids.incidentId },
        body: { note: '越境で解決' },
      })
    ).status,
};

/**
 * 越境の対象外にするオペレーション（理由付きの唯一の除外）。
 *
 * **ここに増える差分は理由の妥当性をレビューで必ず確認する。** 越境を「拒否しないのが正しい」
 * オペレーションは、テナント境界の外側に立つ主体（プラットフォーム管理者）のものだけ。
 */
const CROSS_TENANT_EXEMPT: Record<string, string> = {
  'PATCH /tenants/{tenantId}':
    'プラットフォーム管理者専用。テナント境界の外側に立つ主体の操作なので、' +
    '他テナントを指すことが正しい（テナント内の役割では 403 になることを ' +
    'tests/api/rbac-endpoints.test.ts が固定する）',
};

// 契約を読む（パスパラメータを持つオペレーションを導く）
const spec = parse(readFileSync(join(process.cwd(), 'openapi', 'openapi.yaml'), 'utf8')) as {
  paths: Record<string, Record<string, unknown>>;
};

// HTTP メソッドとして扱うキー（`parameters` などを除く）
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

// 契約から「URL に資源の id を含むオペレーション」のキーを導く
function derivedKeys(): string[] {
  // 結果
  const keys: string[] = [];
  for (const [path, operations] of Object.entries(spec.paths)) {
    // パスパラメータを持たないパスは対象外（越境しようがない）
    if (!path.includes('{')) continue;
    for (const method of HTTP_METHODS) {
      // そのメソッドが定義されていなければ何もしない
      if (!Object.hasOwn(operations, method)) continue;
      keys.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return keys;
}

describe('テナント越境アクセス', () => {
  // 契約から導いたキー
  const keys = derivedKeys();

  it('契約から導いた対象が 1 つ以上ある（走査が壊れていない）', () => {
    // 0 件なら導出が壊れている（「対象ゼロ＝緑」にしない。fail-closed）
    expect(keys.length).toBeGreaterThan(0);
  });

  it('導出した対象と表が一致する（追記漏れ・古い登録のどちらでも落ちる）', () => {
    // 除外を除いた「テストが要るキー」
    const required = keys.filter((key) => !Object.hasOwn(CROSS_TENANT_EXEMPT, key)).sort();
    // 表に登録されているキー
    const registered = Object.keys(CROSS_TENANT_CASES).sort();
    // 双方向で一致すること（**片方向だと、消えたルートの登録が残っていても気付けない**）
    expect(registered).toEqual(required);
  });

  it('除外表は契約に実在するオペレーションに理由付きで載っている', () => {
    // 契約に実在するキーの集合
    const all = new Set(keys);
    for (const [key, reason] of Object.entries(CROSS_TENANT_EXEMPT)) {
      // 消えたオペレーションの除外が残っていないこと
      expect(all.has(key), `除外表の ${key} が契約に無い`).toBe(true);
      // 理由が空でないこと（「とりあえず黙らせる」口を塞ぐ）
      expect(reason.trim().length, `${key} の除外理由が空`).toBeGreaterThan(0);
    }
  });

  // **1 パターンずつテストにする。** まとめて 1 本にすると、どのパターンが拒否されていないかが
  // 失敗の文言からしか分からず、ゲートも「全パターン分 pass したか」を数えられない
  for (const key of Object.keys(CROSS_TENANT_CASES)) {
    it(`越境: ${key}`, async () => {
      // B の資源を用意する
      const ids = await seedForeign(seed);
      // A の admin（権限は足りている）で B の id を指す
      const status = await CROSS_TENANT_CASES[key](seed.a.tokens.admin, ids);
      // **404 であること**（403 だと「その id は存在する」ことが漏れる）
      expect(status, `${key} が 404 以外を返した`).toBe(404);
    });
  }
});
