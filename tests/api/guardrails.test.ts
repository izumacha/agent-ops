// ガードレール・インシデント・監査ログの API テスト（memory アダプタで Route Handler を直接呼ぶ）。
//
// ここで固定するのは 4 つの系統:
//   1. 認可: ルールの作成・削除・インシデントの解決・連鎖の検証は **admin ロール限定**
//      （3×3 の行列そのものは tests/api/rbac-endpoints.test.ts が全オペレーション分見る）
//   2. テナント境界: 他テナントの資源は 404 で隠し、一覧にも混ざらない
//   3. 入力検証: しきい値と集計窓の範囲は**種別ごと**に 422
//   4. 連鎖の検証: 無傷なら ok、書き換えれば**最初に壊れた連番**を返し、鍵が無ければ 503
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { GET as verifyAuditLogs } from '@/app/api/v1/audit-logs/verify/route';
import { AuditAction } from '@/domain/audit/action';
import { AgentStatus, IncidentStatus, Provider, RuleAction, RuleKind } from '@/domain/types';
import { API_MESSAGES, GUARDRAIL_RULES_MAX_PER_TENANT } from '@/lib/constants';
import { call, seedEachTest } from './helpers';

// seed（2 テナント × 3 役割 + 既存エージェント）
const seed = seedEachTest();

// 監査ログの鍵（下限を満たす固定値）
const AUDIT_SECRET = 'guardrails-api-test-audit-secret-0123';
// 既定の集計窓（分）
const WINDOW_MINUTES = 60;

// ルールを 1 件作る（データ層を直接使う。API 経由の作成は別のテストで見る）
async function makeRule(options: {
  tenantId?: string;
  agentId?: string | null;
  kind?: RuleKind;
  threshold?: number;
  action?: RuleAction;
}) {
  // 既定はテナント a のエージェント向けのコスト停止ルール
  const created = await seed.repos.guardrailRules.create(
    {
      tenantId: options.tenantId ?? seed.a.id,
      agentId: options.agentId === undefined ? seed.a.agent.id : options.agentId,
      kind: options.kind ?? RuleKind.cost,
      threshold: options.threshold ?? 1_000,
      windowMinutes: WINDOW_MINUTES,
      action: options.action ?? RuleAction.stop,
    },
    GUARDRAIL_RULES_MAX_PER_TENANT,
  );
  // 作れていなければテストとして落とす
  if (created.status !== 'created') throw new Error(`ルールを作れません: ${created.status}`);
  return created.rule;
}

// 利用イベントを 1 件記録する（コストルールを発火させるのに使う）
async function spend(costMicroUsd: bigint, tenantId = seed.a.id, agentId = seed.a.agent.id) {
  // 料金だけが意味を持つ 1 行
  return seed.repos.usageEvents.record({
    tenantId,
    agentId,
    provider: Provider.anthropic,
    model: 'claude-sonnet-4-6',
    inputTokens: 1,
    outputTokens: 1,
    costMicroUsd,
    latencyMs: 1,
    statusCode: 200,
  });
}

// 発火させて 1 件のインシデントを作る
async function raiseIncident(tenantId = seed.a.id, agentId = seed.a.agent.id) {
  // そのテナントのルール
  const rule = await makeRule({ tenantId, agentId, action: RuleAction.notify });
  // 発火を記録する
  const raised = await seed.repos.incidents.raise({
    tenantId,
    agentId,
    ruleId: rule.id,
    summary: '発火',
    suspendAgent: false,
  });
  // 作れていなければテストとして落とす
  if (raised === null) throw new Error('インシデントを作れません');
  return { rule, incident: raised.incident };
}

beforeEach(() => {
  // 監査ログの鍵（未設定だと記録が欠け、検証は 503 になる）
  vi.stubEnv('AUDIT_HMAC_SECRET', AUDIT_SECRET);
  // 通知は送らない（宛先を設定しないので送信そのものが起きない）
  vi.stubEnv('NOTIFY_WEBHOOK_URL', '');
  vi.stubEnv('NOTIFY_MAIL_WEBHOOK_URL', '');
  // 失敗経路のログでテスト出力を汚さない
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  // 差し替えを戻す
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ガードレールのルール', () => {
  it('admin が登録でき、一覧に出る', async () => {
    // admin で登録する
    const created = await call(createGuardrailRule, {
      token: seed.a.tokens.admin,
      body: {
        agentId: seed.a.agent.id,
        kind: RuleKind.cost,
        threshold: 1_000,
        windowMinutes: WINDOW_MINUTES,
        action: RuleAction.stop,
      },
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    // 既定で有効になっている
    expect(created.json).toMatchObject({ enabled: true, kind: RuleKind.cost });
    // 一覧（view 権限で読める）に出る
    const listed = await call(listGuardrailRules, { token: seed.a.tokens.viewer });
    expect(listed.status).toBe(200);
    expect((listed.json as { items: { id: string }[] }).items.map((row) => row.id)).toEqual([
      (created.json as { id: string }).id,
    ]);
  });

  it('agentId を省略するとテナント全体へ掛かるルールになる', async () => {
    // agentId を渡さない
    const created = await call(createGuardrailRule, {
      token: seed.a.tokens.admin,
      body: {
        kind: RuleKind.error_rate,
        threshold: 0.5,
        windowMinutes: WINDOW_MINUTES,
        action: RuleAction.notify,
      },
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    // null として保存される
    expect(created.json).toMatchObject({ agentId: null });
  });

  it('他テナントのエージェントを指すと 404（存在を隠す）', async () => {
    // テナント a の admin がテナント b のエージェントを指す
    const created = await call(createGuardrailRule, {
      token: seed.a.tokens.admin,
      body: {
        agentId: seed.b.agent.id,
        kind: RuleKind.cost,
        threshold: 1_000,
        windowMinutes: WINDOW_MINUTES,
        action: RuleAction.stop,
      },
    });
    // 403 ではなく 404（403 だと「そのエージェントは存在する」ことが漏れる）
    expect(created.status).toBe(404);
  });

  it('ルール数の上限に達したら 409', async () => {
    // 上限ぶん作る
    for (let i = 0; i < GUARDRAIL_RULES_MAX_PER_TENANT; i += 1) {
      await makeRule({ action: RuleAction.notify });
    }
    // 次の 1 件は作れない
    const created = await call(createGuardrailRule, {
      token: seed.a.tokens.admin,
      body: {
        kind: RuleKind.cost,
        threshold: 1_000,
        windowMinutes: WINDOW_MINUTES,
        action: RuleAction.notify,
      },
    });
    expect(created.status).toBe(409);
    expect(created.json).toMatchObject({ message: API_MESSAGES.guardrailRuleLimit });
  });

  it.each([
    ['コストに小数', RuleKind.cost, 0.5],
    ['コストに負の値', RuleKind.cost, -1],
    ['エラー率が 1 を超える', RuleKind.error_rate, 1.5],
    ['品質が負の値', RuleKind.quality, -0.1],
  ])('しきい値が種別の範囲外なら 422 (%s)', async (_label, kind, threshold) => {
    // 範囲外のしきい値で登録しようとする
    const created = await call(createGuardrailRule, {
      token: seed.a.tokens.admin,
      body: { kind, threshold, windowMinutes: WINDOW_MINUTES, action: RuleAction.notify },
    });
    expect(created.status).toBe(422);
    // どの項目が誤りかを添える
    expect(created.json).toMatchObject({ issues: [{ path: 'threshold' }] });
  });

  it.each([
    ['0 分（幅ゼロの窓は永久に発火しない）', 0],
    ['7 日を超える', 10_081],
    ['小数', 1.5],
  ])('集計窓が範囲外なら 422 (%s)', async (_label, windowMinutes) => {
    // 範囲外の窓で登録しようとする
    const created = await call(createGuardrailRule, {
      token: seed.a.tokens.admin,
      body: { kind: RuleKind.cost, threshold: 1_000, windowMinutes, action: RuleAction.notify },
    });
    expect(created.status).toBe(422);
    expect(created.json).toMatchObject({ issues: [{ path: 'windowMinutes' }] });
  });

  it('未知キーは 422（黙って剥がさない）', async () => {
    // 契約に無い項目を混ぜる
    const created = await call(createGuardrailRule, {
      token: seed.a.tokens.admin,
      body: {
        kind: RuleKind.cost,
        threshold: 1_000,
        windowMinutes: WINDOW_MINUTES,
        action: RuleAction.notify,
        enabled: false,
      },
    });
    // 剥がして 201 にすると「enabled: false で作ったのに有効」という無言の無視になる
    expect(created.status).toBe(422);
  });

  it('他テナントのルールは一覧に混ざらない', async () => {
    // 両テナントに 1 件ずつ作る
    const mine = await makeRule({ action: RuleAction.notify });
    await makeRule({ tenantId: seed.b.id, agentId: seed.b.agent.id, action: RuleAction.notify });
    // テナント a から一覧する
    const listed = await call(listGuardrailRules, { token: seed.a.tokens.viewer });
    expect((listed.json as { items: { id: string }[] }).items.map((row) => row.id)).toEqual([
      mine.id,
    ]);
  });

  it('admin が削除でき、他テナントの id は 404', async () => {
    // 自テナントのルール
    const rule = await makeRule({ action: RuleAction.notify });
    // 他テナントのルール
    const otherRule = await makeRule({
      tenantId: seed.b.id,
      agentId: seed.b.agent.id,
      action: RuleAction.notify,
    });
    // 他テナントの id は消せない
    expect(
      (
        await call(deleteGuardrailRule, {
          token: seed.a.tokens.admin,
          method: 'DELETE',
          params: { ruleId: otherRule.id },
        })
      ).status,
    ).toBe(404);
    // 自テナントの id は消せる
    expect(
      (
        await call(deleteGuardrailRule, {
          token: seed.a.tokens.admin,
          method: 'DELETE',
          params: { ruleId: rule.id },
        })
      ).status,
    ).toBe(204);
    // 消えている
    expect(seed.store.guardrailRules.has(rule.id)).toBe(false);
    // 他テナントのルールは残っている
    expect(seed.store.guardrailRules.has(otherRule.id)).toBe(true);
  });

  it('発火記録を持つルールは削除できない（409）', async () => {
    // **記録からルールを辿れなくなると「何がなぜ止めたのか」が読めなくなる**
    const { rule } = await raiseIncident();
    const deleted = await call(deleteGuardrailRule, {
      token: seed.a.tokens.admin,
      method: 'DELETE',
      params: { ruleId: rule.id },
    });
    expect(deleted.status).toBe(409);
    expect(deleted.json).toMatchObject({ message: API_MESSAGES.guardrailRuleHasIncidents });
  });
});

describe('ガードレールのルールの無効化', () => {
  // ルールの `enabled` を切り替える（admin 限定）。**発火記録を持つルールは削除できない**ので、
  // しきい値を誤った `stop` のルールを止める手段はこれだけ（それが無かったあいだ、誤設定の
  // ルールはインシデントを解決してエージェントを復帰させても次の中継で再び発火していた）
  it('無効化すると判定の対象から外れる（停止が止まる）', async () => {
    // しきい値 1000 に対して 1500 使った状態（この時点で発火する条件を満たしている）
    const rule = await makeRule({ threshold: 1_000, action: RuleAction.stop });
    await spend(1_500n);
    // admin で無効化する
    const patched = await call(updateGuardrailRule, {
      token: seed.a.tokens.admin,
      method: 'PATCH',
      params: { ruleId: rule.id },
      body: { enabled: false },
    });
    expect(patched.status, JSON.stringify(patched.json)).toBe(200);
    // 切り替えた後の行を返す
    expect(patched.json).toMatchObject({ id: rule.id, enabled: false });
    // 明示実行しても 1 件も判定されない（＝停止もしない）
    const result = await call(runGuardrails, {
      token: seed.a.tokens.admin,
      body: { agentId: seed.a.agent.id },
    });
    expect(result.json).toMatchObject({ evaluated: 0, fired: [] });
    // エージェントは動いたまま
    expect(seed.store.agents.get(seed.a.agent.id)?.status).toBe(AgentStatus.active);
  });

  it('発火記録を持つルールでも無効化できる（削除は 409 なのでこれが唯一の止め方）', async () => {
    // 発火記録を持つルールを用意する（削除は 409 になる状態）
    const { rule } = await raiseIncident();
    // 無効化は通る
    const patched = await call(updateGuardrailRule, {
      token: seed.a.tokens.admin,
      method: 'PATCH',
      params: { ruleId: rule.id },
      body: { enabled: false },
    });
    expect(patched.status, JSON.stringify(patched.json)).toBe(200);
    expect(patched.json).toMatchObject({ enabled: false });
    // **記録は残っている**（「何がなぜ止めたのか」を読める状態を壊さない）
    expect(seed.store.guardrailRules.has(rule.id)).toBe(true);
  });

  it('再度有効にすると判定の対象へ戻る', async () => {
    // 外してから戻す
    const rule = await makeRule({ threshold: 1_000, action: RuleAction.stop });
    await spend(1_500n);
    await call(updateGuardrailRule, {
      token: seed.a.tokens.admin,
      method: 'PATCH',
      params: { ruleId: rule.id },
      body: { enabled: false },
    });
    const restored = await call(updateGuardrailRule, {
      token: seed.a.tokens.admin,
      method: 'PATCH',
      params: { ruleId: rule.id },
      body: { enabled: true },
    });
    expect(restored.json).toMatchObject({ enabled: true });
    // 戻した後は発火する
    const result = await call(runGuardrails, {
      token: seed.a.tokens.admin,
      body: { agentId: seed.a.agent.id },
    });
    expect(result.json).toMatchObject({ evaluated: 1 });
    expect(seed.store.agents.get(seed.a.agent.id)?.status).toBe(AgentStatus.suspended);
  });

  it('同じ値を 2 回送っても 200（冪等）', async () => {
    // 2 度押し・再試行を 409 にしない（求めている状態はどちらも同じ）
    const rule = await makeRule({ action: RuleAction.notify });
    for (let i = 0; i < 2; i += 1) {
      const patched = await call(updateGuardrailRule, {
        token: seed.a.tokens.admin,
        method: 'PATCH',
        params: { ruleId: rule.id },
        body: { enabled: false },
      });
      expect(patched.status).toBe(200);
      expect(patched.json).toMatchObject({ enabled: false });
    }
  });

  it('無効化したルールは件数の上限に数えない', async () => {
    // **数え方を「有効なルールだけ」にしてある** — 無効化した行も数えると、上限ぶん発火して
    // しまったテナントは「消せない・止めても枠が空かない」でルールを 1 件も作れなくなる
    const rules = [];
    for (let i = 0; i < GUARDRAIL_RULES_MAX_PER_TENANT; i += 1) {
      rules.push(await makeRule({ action: RuleAction.notify }));
    }
    // この時点では上限に達している
    const refused = await call(createGuardrailRule, {
      token: seed.a.tokens.admin,
      body: {
        kind: RuleKind.cost,
        threshold: 1_000,
        windowMinutes: WINDOW_MINUTES,
        action: RuleAction.notify,
      },
    });
    expect(refused.status).toBe(409);
    // 1 件無効化すると枠が空く
    await call(updateGuardrailRule, {
      token: seed.a.tokens.admin,
      method: 'PATCH',
      params: { ruleId: rules[0].id },
      body: { enabled: false },
    });
    const created = await call(createGuardrailRule, {
      token: seed.a.tokens.admin,
      body: {
        kind: RuleKind.cost,
        threshold: 1_000,
        windowMinutes: WINDOW_MINUTES,
        action: RuleAction.notify,
      },
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
  });

  it('他テナントのルールは無効化できない（404 で存在を隠す）', async () => {
    // テナント b のルール
    const otherRule = await makeRule({
      tenantId: seed.b.id,
      agentId: seed.b.agent.id,
      action: RuleAction.notify,
    });
    // テナント a の admin からは触れない
    const patched = await call(updateGuardrailRule, {
      token: seed.a.tokens.admin,
      method: 'PATCH',
      params: { ruleId: otherRule.id },
      body: { enabled: false },
    });
    expect(patched.status).toBe(404);
    // 他テナントの行は有効なまま
    expect(seed.store.guardrailRules.get(otherRule.id)?.enabled).toBe(true);
  });

  it('未知キーは 422（黙って剥がさない）', async () => {
    // 契約に無い項目（しきい値の変更など）を混ぜても受け付けない
    const rule = await makeRule({ action: RuleAction.notify });
    const patched = await call(updateGuardrailRule, {
      token: seed.a.tokens.admin,
      method: 'PATCH',
      params: { ruleId: rule.id },
      body: { enabled: false, threshold: 1 },
    });
    expect(patched.status).toBe(422);
    // 無効化もされていない
    expect(seed.store.guardrailRules.get(rule.id)?.enabled).toBe(true);
  });

  it('監査ログの鍵が無ければ 503 で、enabled は変わらない', async () => {
    // 変えてから記録に失敗すると「いつ誰が止める条件を外したか」が辿れない
    const rule = await makeRule({ action: RuleAction.notify });
    vi.stubEnv('AUDIT_HMAC_SECRET', '');
    const refused = await call(updateGuardrailRule, {
      token: seed.a.tokens.admin,
      method: 'PATCH',
      params: { ruleId: rule.id },
      body: { enabled: false },
    });
    expect(refused.status).toBe(503);
    // 行は有効なまま
    expect(seed.store.guardrailRules.get(rule.id)?.enabled).toBe(true);
  });

  it('無効化と再有効化は別の操作として監査ログに残る', async () => {
    // 操作名を分けるのは、記録を読むとき「外した」と「戻した」が区別できる必要があるため
    const rule = await makeRule({ action: RuleAction.notify });
    for (const enabled of [false, true]) {
      await call(updateGuardrailRule, {
        token: seed.a.tokens.admin,
        method: 'PATCH',
        params: { ruleId: rule.id },
        body: { enabled },
      });
    }
    const logs = await call(listAuditLogs, { token: seed.a.tokens.admin });
    const items = (
      logs.json as {
        items: {
          action: string;
          actorId: string | null;
          targetType: string;
          targetId: string;
          payload: Record<string, unknown> | null;
        }[];
      }
    ).items;
    // 外した記録
    const disabled = items.find((item) => item.action === AuditAction.guardrail_rule_disabled);
    expect(disabled?.actorId).toBe(seed.a.users.admin.id);
    expect(disabled?.targetType).toBe('GuardrailRule');
    expect(disabled?.targetId).toBe(rule.id);
    expect(disabled?.payload).toEqual({ enabled: false });
    // 戻した記録
    const enabledRow = items.find((item) => item.action === AuditAction.guardrail_rule_enabled);
    expect(enabledRow?.targetId).toBe(rule.id);
    expect(enabledRow?.payload).toEqual({ enabled: true });
  });
});

describe('ガードレールの明示実行', () => {
  // **stop 権限は admin だけが持つ**（src/domain/rbac.ts の許可表）。発火すると停止しうるので
  // 停止と同じ権限を要求しており、operator では 403 になる（その 1 件は
  // tests/api/rbac-endpoints.test.ts が全オペレーション分まとめて見る）
  it('超過していれば発火して停止し、結果を返す', async () => {
    // しきい値 1000 に対して 1500 使った状態
    await makeRule({ threshold: 1_000, action: RuleAction.stop });
    await spend(1_500n);
    // stop 権限（operator）で明示実行する
    const result = await call(runGuardrails, {
      token: seed.a.tokens.admin,
      body: { agentId: seed.a.agent.id },
    });
    expect(result.status, JSON.stringify(result.json)).toBe(200);
    // 1 件判定して 1 件発火した
    expect(result.json).toMatchObject({ evaluated: 1 });
    const body = result.json as { fired: { kind: string; suspended: boolean }[] };
    expect(body.fired).toHaveLength(1);
    expect(body.fired[0]).toMatchObject({ kind: RuleKind.cost, suspended: true });
    // エージェントが停止している
    expect(seed.store.agents.get(seed.a.agent.id)?.status).toBe(AgentStatus.suspended);
  });

  it('ルールが無ければ judged 0 件で何も起きない', async () => {
    // ルールを作らずに実行する
    await spend(99_999n);
    const result = await call(runGuardrails, {
      token: seed.a.tokens.admin,
      body: { agentId: seed.a.agent.id },
    });
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ evaluated: 0, fired: [] });
    // 停止もしていない
    expect(seed.store.agents.get(seed.a.agent.id)?.status).toBe(AgentStatus.active);
  });

  it('他テナントのエージェントを指すと 404', async () => {
    // テナント a の operator がテナント b のエージェントを指す
    const result = await call(runGuardrails, {
      token: seed.a.tokens.admin,
      body: { agentId: seed.b.agent.id },
    });
    expect(result.status).toBe(404);
  });

  it('全種別を見る（品質ルールも発火しうる）', async () => {
    // **明示実行は「いま止まるべきか」を網羅的に確かめる操作**なので種別を絞らない。
    // 中継の経路では品質を見ないので、ここで見ないと品質ルールを確かめる経路が無くなる
    await makeRule({ kind: RuleKind.quality, threshold: 0.9, action: RuleAction.stop });
    // 低いスコアの評価実行を 1 件入れる
    const set = await seed.repos.evaluations.createSet({
      tenantId: seed.a.id,
      name: 'セット',
      cases: [{ input: '入力', expected: null }],
    });
    await seed.repos.evaluations.createRun({
      tenantId: seed.a.id,
      agentId: seed.a.agent.id,
      setId: set.set.id,
      accuracy: 0.2,
      safety: 0.2,
      // 逸脱は「低いほど良い」ので、ここは良い値（品質は accuracy / safety が引き下げる）
      deviation: 0,
      status: 'completed',
      scoredCases: 1,
      excludedCases: 0,
      judgeProvider: Provider.anthropic,
      judgeModel: 'claude-haiku-4-5',
      results: [],
    });
    // 実行する
    const result = await call(runGuardrails, {
      token: seed.a.tokens.admin,
      body: { agentId: seed.a.agent.id },
    });
    expect(result.status).toBe(200);
    // 品質ルールが発火している
    expect((result.json as { fired: { kind: string }[] }).fired[0]).toMatchObject({
      kind: RuleKind.quality,
    });
  });
});

describe('インシデント', () => {
  it('一覧をエージェントと状態で絞れる', async () => {
    // 2 件作って 1 件を解決する
    const first = await raiseIncident();
    const second = await raiseIncident();
    await seed.repos.incidents.resolve(seed.a.id, second.incident.id);
    // 絞り込みなし（2 件）
    const all = await call(listIncidents, { token: seed.a.tokens.viewer });
    expect((all.json as { items: unknown[] }).items).toHaveLength(2);
    // open だけ（1 件）
    const open = await call(listIncidents, {
      token: seed.a.tokens.viewer,
      query: `status=${IncidentStatus.open}`,
    });
    expect((open.json as { items: { id: string }[] }).items.map((row) => row.id)).toEqual([
      first.incident.id,
    ]);
    // エージェントで絞る（同じエージェントなので 2 件）
    const byAgent = await call(listIncidents, {
      token: seed.a.tokens.viewer,
      query: `agentId=${seed.a.agent.id}`,
    });
    expect((byAgent.json as { items: unknown[] }).items).toHaveLength(2);
  });

  it('他テナントのインシデントは一覧に混ざらない', async () => {
    // 両テナントに 1 件ずつ
    const mine = await raiseIncident();
    await raiseIncident(seed.b.id, seed.b.agent.id);
    // テナント a から一覧する
    const listed = await call(listIncidents, { token: seed.a.tokens.viewer });
    expect((listed.json as { items: { id: string }[] }).items.map((row) => row.id)).toEqual([
      mine.incident.id,
    ]);
  });

  it('admin が解決でき、2 回目は 409', async () => {
    // 1 件作る
    const { incident } = await raiseIncident();
    // 1 回目は成功
    const first = await call(resolveIncident, {
      token: seed.a.tokens.admin,
      params: { incidentId: incident.id },
    });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json).toMatchObject({ status: IncidentStatus.resolved });
    // 解決日時が入っている
    expect((first.json as { resolvedAt: string | null }).resolvedAt).not.toBeNull();
    // 2 回目は 409（条件付き更新なので二重に成功しない）
    const second = await call(resolveIncident, {
      token: seed.a.tokens.admin,
      params: { incidentId: incident.id },
    });
    expect(second.status).toBe(409);
    expect(second.json).toMatchObject({ message: API_MESSAGES.incidentAlreadyResolved });
  });

  it('解決してもエージェントは復帰しない（別操作）', async () => {
    // **「原因に対処した」と「また動かしてよい」は別の判断**。まとめると
    // 「原因は分かったがまだ動かしたくない」運用ができなくなる
    const { rule } = await raiseIncident();
    // 停止を伴う発火を作る
    const raised = await seed.repos.incidents.raise({
      tenantId: seed.a.id,
      agentId: seed.a.agent.id,
      ruleId: rule.id,
      summary: '発火',
      suspendAgent: true,
    });
    if (raised === null) throw new Error('インシデントを作れません');
    expect(seed.store.agents.get(seed.a.agent.id)?.status).toBe(AgentStatus.suspended);
    // 解決する
    await call(resolveIncident, {
      token: seed.a.tokens.admin,
      params: { incidentId: raised.incident.id },
    });
    // **エージェントは停止したまま**
    expect(seed.store.agents.get(seed.a.agent.id)?.status).toBe(AgentStatus.suspended);
  });

  it('他テナントのインシデントは解決できない（404）', async () => {
    // テナント b のインシデント
    const { incident } = await raiseIncident(seed.b.id, seed.b.agent.id);
    // テナント a の admin からは見えない
    const result = await call(resolveIncident, {
      token: seed.a.tokens.admin,
      params: { incidentId: incident.id },
    });
    expect(result.status).toBe(404);
    // 状態も変わっていない
    expect(seed.store.incidents.get(incident.id)?.status).toBe(IncidentStatus.open);
  });

  it('解決は監査ログに残る', async () => {
    // 1 件作って解決する
    const { incident } = await raiseIncident();
    await call(resolveIncident, {
      token: seed.a.tokens.admin,
      params: { incidentId: incident.id },
    });
    // 監査ログに「誰が解決したか」が入る
    const rows = [...seed.store.auditLogs.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: AuditAction.incident_resolved,
      actorId: seed.a.users.admin.id,
      targetId: incident.id,
    });
  });

  it('監査ログの鍵が無ければ解決そのものを失敗させる（503）', async () => {
    // **人の操作では fail-closed。** UC-09 の事後条件「監査ログに残る」を守れないまま
    // 成功を返さない（自動発火は止める側を優先するので扱いが逆になる）
    const { incident } = await raiseIncident();
    vi.stubEnv('AUDIT_HMAC_SECRET', '');
    const result = await call(resolveIncident, {
      token: seed.a.tokens.admin,
      params: { incidentId: incident.id },
    });
    expect(result.status).toBe(503);
  });
});

describe('人の操作は監査ログを書けないなら状態も変えない', () => {
  // **ここが「状態変更 → 記録」の順序の検査。** 変えてから記録に失敗すると、記録の無い変更が
  // 残り、しかも再試行は「既にその状態だ」で永久に失敗する（実測で resolve がそうなっていた:
  // 503 を返しながら incident は resolved になり、鍵を設定して再試行しても 409 が返り続けた）。
  // UC-09 の事後条件「監査ログに残る」が**恒久的に達成不能**になる形なので、両方を固定する。

  it('インシデントの解決: 鍵が無ければ 503 で、状態は open のまま', async () => {
    // 発火を 1 件作る
    const { incident } = await raiseIncident();
    // 鍵を外す
    vi.stubEnv('AUDIT_HMAC_SECRET', '');
    // 解決を呼ぶと 503
    const refused = await call(resolveIncident, {
      token: seed.a.tokens.admin,
      params: { incidentId: incident.id },
    });
    expect(refused.status).toBe(503);
    // **状態は変わっていない**（ここが要点。変わっていると下の再試行が 409 になる）
    const stored = await seed.repos.incidents.findById(seed.a.id, incident.id);
    expect(stored?.status).toBe(IncidentStatus.open);
    // 鍵を戻せば成功する（恒久的に失敗しない）
    vi.stubEnv('AUDIT_HMAC_SECRET', AUDIT_SECRET);
    const retried = await call(resolveIncident, {
      token: seed.a.tokens.admin,
      params: { incidentId: incident.id },
    });
    expect(retried.status).toBe(200);
    // 記録も残っている
    const logs = await call(listAuditLogs, { token: seed.a.tokens.admin });
    expect((logs.json as { items: { action: string }[] }).items.map((row) => row.action)).toContain(
      AuditAction.incident_resolved,
    );
  });

  it('ルールの登録: 鍵が無ければ 503 で、ルールは作られない', async () => {
    // 鍵を外す
    vi.stubEnv('AUDIT_HMAC_SECRET', '');
    // 登録を呼ぶと 503
    const refused = await call(createGuardrailRule, {
      token: seed.a.tokens.admin,
      body: {
        agentId: seed.a.agent.id,
        kind: RuleKind.cost,
        threshold: 1_000,
        windowMinutes: WINDOW_MINUTES,
        action: RuleAction.notify,
      },
    });
    expect(refused.status).toBe(503);
    // **「誰が入れたか分からないルール」が残っていない**
    expect(seed.store.guardrailRules.size).toBe(0);
  });

  it('ルールの削除: 鍵が無ければ 503 で、ルールは消えない', async () => {
    // 発火記録を持たないルールを 1 件作る（記録があると 409 になって順序を試せない）
    const rule = await makeRule({});
    // 鍵を外す
    vi.stubEnv('AUDIT_HMAC_SECRET', '');
    // 削除を呼ぶと 503
    const refused = await call(deleteGuardrailRule, {
      token: seed.a.tokens.admin,
      method: 'DELETE',
      params: { ruleId: rule.id },
    });
    expect(refused.status).toBe(503);
    // **行は残っている**（消えていると「いつ誰が外したか」が永久に分からない）
    expect(seed.store.guardrailRules.has(rule.id)).toBe(true);
  });
});

describe('ルールの設定変更は監査ログに残る', () => {
  it('登録は設定の中身を payload に残す', async () => {
    // admin で 1 件作る
    const created = await call(createGuardrailRule, {
      token: seed.a.tokens.admin,
      body: {
        agentId: seed.a.agent.id,
        kind: RuleKind.error_rate,
        threshold: 0.5,
        windowMinutes: WINDOW_MINUTES,
        action: RuleAction.stop,
      },
    });
    expect(created.status).toBe(201);
    // 監査ログに「登録」が残り、判断の根拠になる設定を持つ
    const logs = await call(listAuditLogs, { token: seed.a.tokens.admin });
    const row = (
      logs.json as {
        items: {
          action: string;
          targetType: string;
          targetId: string;
          actorId: string | null;
          payload: Record<string, unknown> | null;
        }[];
      }
    ).items.find((item) => item.action === AuditAction.guardrail_rule_created);
    // 操作主体は作った admin 自身
    expect(row?.actorId).toBe(seed.a.users.admin.id);
    expect(row?.targetType).toBe('GuardrailRule');
    expect(row?.targetId).toBe((created.json as { id: string }).id);
    expect(row?.payload).toEqual({
      agentId: seed.a.agent.id,
      kind: RuleKind.error_rate,
      threshold: 0.5,
      windowMinutes: WINDOW_MINUTES,
      action: RuleAction.stop,
    });
  });

  it('削除は対象の id を残す（中身は作成時の記録が持っている）', async () => {
    // 発火記録を持たないルールを作って消す
    const rule = await makeRule({});
    const deleted = await call(deleteGuardrailRule, {
      token: seed.a.tokens.admin,
      method: 'DELETE',
      params: { ruleId: rule.id },
    });
    expect(deleted.status).toBe(204);
    // 監査ログに「削除」が残る
    const logs = await call(listAuditLogs, { token: seed.a.tokens.admin });
    const row = (
      logs.json as {
        items: { action: string; targetId: string; payload: Record<string, unknown> | null }[];
      }
    ).items.find((item) => item.action === AuditAction.guardrail_rule_deleted);
    expect(row?.targetId).toBe(rule.id);
    // 消えた行の設定は残せないので payload は無い
    expect(row?.payload).toBeNull();
  });
});

describe('監査ログと連鎖の検証', () => {
  // 監査ログを 1 行追記する（API 経由の操作で増やす）
  async function appendViaResolve() {
    // 発火 → 解決で 1 行増える
    const { incident } = await raiseIncident();
    await call(resolveIncident, {
      token: seed.a.tokens.admin,
      params: { incidentId: incident.id },
    });
  }

  it('一覧にハッシュは載らない（鍵を持たない側は検証できないので偽の安心を作らない）', async () => {
    // 1 行書く
    await appendViaResolve();
    // 一覧する
    const listed = await call(listAuditLogs, { token: seed.a.tokens.viewer });
    expect(listed.status).toBe(200);
    const items = (listed.json as { items: Record<string, unknown>[] }).items;
    expect(items).toHaveLength(1);
    // hash / prevHash は含まれない
    expect(items[0]).not.toHaveProperty('hash');
    expect(items[0]).not.toHaveProperty('prevHash');
    // 連番は文字列で運ぶ（BigInt を JSON の数値にすると 2^53 で精度が落ちる）
    expect(items[0]?.seq).toBe('1');
  });

  it('無傷なら ok を返す', async () => {
    // 2 行書く
    await appendViaResolve();
    await appendViaResolve();
    // admin で検証する
    const result = await call(verifyAuditLogs, { token: seed.a.tokens.admin });
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ ok: true, verified: 2, reachedLimit: false });
  });

  it('1 行書き換えると最初に壊れた連番と理由を返す（壊れていても 200）', async () => {
    // 3 行書く
    await appendViaResolve();
    await appendViaResolve();
    await appendViaResolve();
    // **表を直接書き換える**（Port には更新のメソッドが無いので、prisma 側でトリガを外すのと同じ立場）
    const rows = [...seed.store.auditLogs.values()].sort((x, y) => Number(x.seq - y.seq));
    const target = rows[1];
    if (!target) throw new Error('行が見つかりません');
    seed.store.auditLogs.set(target.id, { ...target, action: 'tampered' });
    // 検証する
    const result = await call(verifyAuditLogs, { token: seed.a.tokens.admin });
    // **壊れていても 200**（HTTP のエラーにすると監視が「API が落ちた」と読む）
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({
      ok: false,
      // 壊れた行の手前までの件数（読んだ件数ではない）
      verified: 1,
      brokenSeq: '2',
      reason: 'hash_mismatch',
    });
  });

  it('fromSeq で続きの区間を検証でき、継ぎ目も確かめる', async () => {
    // **これが無いと、行数が 1 回の上限を超えたテナントでは最古の区間しか検証されない**
    // （それ以降の行を書き換えても「無傷」と答え、改ざん検知が静かに効かなくなる）
    await appendViaResolve();
    await appendViaResolve();
    await appendViaResolve();
    // 2 件目から検証する
    const result = await call(verifyAuditLogs, {
      token: seed.a.tokens.admin,
      query: 'fromSeq=2',
    });
    expect(result.status).toBe(200);
    // 2 件（2 件目と 3 件目）を検証し、継ぎ目も通っている
    expect(result.json).toMatchObject({ ok: true, verified: 2, reachedLimit: false });
    // **継ぎ目を見ている**: 1 件目を書き換えると、2 件目から始めた検証が落ちる
    const rows = [...seed.store.auditLogs.values()].sort((x, y) => Number(x.seq - y.seq));
    const head = rows[0];
    if (!head) throw new Error('行が見つかりません');
    seed.store.auditLogs.set(head.id, { ...head, hash: 'deadbeef' });
    const broken = await call(verifyAuditLogs, {
      token: seed.a.tokens.admin,
      query: 'fromSeq=2',
    });
    expect(broken.json).toMatchObject({ ok: false, brokenSeq: '2', reason: 'prev_hash_mismatch' });
  });

  it('fromSeq の形が違えば 422', async () => {
    // 連番は 1 以上の 10 進整数だけ（空文字・符号付き・小数・指数は弾く）
    for (const value of ['', '0', '-1', '1.5', '1e3', 'abc', ' 1']) {
      const result = await call(verifyAuditLogs, {
        token: seed.a.tokens.admin,
        query: `fromSeq=${encodeURIComponent(value)}`,
      });
      expect(result.status, `fromSeq=${value}`).toBe(422);
    }
  });

  it('鍵が未設定なら 503（鍵なしで「無傷」と答えない）', async () => {
    // 1 行書いてから鍵を外す
    await appendViaResolve();
    vi.stubEnv('AUDIT_HMAC_SECRET', '');
    // 検証を呼ぶ
    const result = await call(verifyAuditLogs, { token: seed.a.tokens.admin });
    expect(result.status).toBe(503);
  });

  it('他テナントの行は一覧にも検証にも混ざらない', async () => {
    // テナント b で 1 行書く
    const other = await raiseIncident(seed.b.id, seed.b.agent.id);
    await call(resolveIncident, {
      token: seed.b.tokens.admin,
      params: { incidentId: other.incident.id },
    });
    // テナント a は 0 行
    const listed = await call(listAuditLogs, { token: seed.a.tokens.viewer });
    expect((listed.json as { items: unknown[] }).items).toHaveLength(0);
    // 検証も 0 行で ok（行が無いことは「無傷」）
    const verified = await call(verifyAuditLogs, { token: seed.a.tokens.admin });
    expect(verified.json).toMatchObject({ ok: true, verified: 0 });
  });
});

describe('テナントの範囲は資格情報だけが決める', () => {
  // **要求がテナントを選べてはいけない。** 変異で確かめたところ、解決のルートが
  // `?tenantId=` を優先する形（クロステナントの典型的な穴）にしても 31 件すべてが緑で通った。
  // どのテストも「テナントを指定しようとする要求」を送っていなかったため。
  // ここは**攻撃そのものを送って**、指定が効かないことを見る

  it('クエリでテナントを指定しても他テナントのインシデントは解決できない', async () => {
    // テナント b のインシデント
    const { incident } = await raiseIncident(seed.b.id, seed.b.agent.id);
    // テナント a の admin が、クエリで b のテナント id を指定して解決を試みる
    const result = await call(resolveIncident, {
      token: seed.a.tokens.admin,
      params: { incidentId: incident.id },
      query: `tenantId=${seed.b.id}`,
    });
    // 指定は効かないので 404（自テナントには無い）
    expect(result.status).toBe(404);
    // b のインシデントは開いたまま
    expect(seed.store.incidents.get(incident.id)?.status).toBe(IncidentStatus.open);
  });

  it('クエリでテナントを指定しても他テナントのルールは一覧に出ない', async () => {
    // 自テナントに 1 件、他テナントに 1 件
    const mine = await makeRule({ action: RuleAction.notify });
    const other = await makeRule({
      tenantId: seed.b.id,
      agentId: seed.b.agent.id,
      action: RuleAction.notify,
    });
    // テナント b を指定して一覧する
    const listed = await call(listGuardrailRules, {
      token: seed.a.tokens.viewer,
      query: `tenantId=${seed.b.id}`,
    });
    // 自テナントの 1 件だけが返る
    const ids = (listed.json as { items: { id: string }[] }).items.map((row) => row.id);
    expect(ids).toEqual([mine.id]);
    expect(ids).not.toContain(other.id);
  });

  it('クエリでテナントを指定しても他テナントの監査ログは見えない', async () => {
    // テナント b で 1 行書く
    const other = await raiseIncident(seed.b.id, seed.b.agent.id);
    await call(resolveIncident, {
      token: seed.b.tokens.admin,
      params: { incidentId: other.incident.id },
    });
    // テナント a が b を指定して一覧・検証する
    const listed = await call(listAuditLogs, {
      token: seed.a.tokens.viewer,
      query: `tenantId=${seed.b.id}`,
    });
    expect((listed.json as { items: unknown[] }).items).toHaveLength(0);
    // 検証も自テナント（0 行）のまま
    const verified = await call(verifyAuditLogs, {
      token: seed.a.tokens.admin,
      query: `tenantId=${seed.b.id}`,
    });
    expect(verified.json).toMatchObject({ ok: true, verified: 0 });
  });

  it('クエリでテナントを指定しても他テナントのエージェントは判定できない', async () => {
    // テナント b に必ず発火するルールと利用を仕込む
    await makeRule({ tenantId: seed.b.id, agentId: seed.b.agent.id, threshold: 0 });
    await spend(1_000n, seed.b.id, seed.b.agent.id);
    // テナント a の admin が b のエージェントを b のテナント id 付きで判定しようとする
    const result = await call(runGuardrails, {
      token: seed.a.tokens.admin,
      body: { agentId: seed.b.agent.id },
      query: `tenantId=${seed.b.id}`,
    });
    // 404（自テナントにそのエージェントは無い）
    expect(result.status).toBe(404);
    // b のエージェントは動いたまま
    expect(seed.store.agents.get(seed.b.agent.id)?.status).toBe(AgentStatus.active);
  });
});
