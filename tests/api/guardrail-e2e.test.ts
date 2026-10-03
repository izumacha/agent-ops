// Step4 の受け入れ基準 3「E2E で『登録→実行→超過→停止→復帰』が通る」を 1 本のテストで固定する。
//
// **段ごとに分けない。** 分けると各段は緑なのに「前の段の結果を次の段が受け取れていない」
// 形（登録したルールが中継の経路から見えない・停止したエージェントが復帰できない）に気付けない。
// 1 本で順に通すので、どこかで切れていればその段で落ちる。
//
// 通る経路はすべて**本番と同じ Route Handler**（memory アダプタ・HTTP を介さない直接呼び出し）で、
// 上流 LLM だけを fetch の差し替えで模す — **実際の Anthropic / OpenAI は呼ばず課金も発生しない。**
//
// **ゲート（scripts/gate-step4.mjs）はこのテストの名前で pass を照合する。**
// 名前は `scripts/lib/step4-criteria.mjs` の `GUARDRAIL_E2E_TEST_NAME` が正本なので、
// 変えるときは両方そろえる（片方だけ変えるとゲートが「E2E が無い」で落ちる）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as createAgent } from '@/app/api/v1/agents/route';
import { POST as resumeAgent } from '@/app/api/v1/agents/[agentId]/resume/route';
import { GET as getAgent } from '@/app/api/v1/agents/[agentId]/route';
import { POST as createApiKey } from '@/app/api/v1/api-keys/route';
import { POST as createGuardrailRule } from '@/app/api/v1/guardrails/route';
import { POST as proxyAnthropic } from '@/app/api/v1/proxy/anthropic/messages/route';
import { GET as listIncidents } from '@/app/api/v1/incidents/route';
import { POST as resolveIncident } from '@/app/api/v1/incidents/[incidentId]/resolve/route';
import { GET as listAuditLogs } from '@/app/api/v1/audit-logs/route';
import { GET as verifyAuditLogs } from '@/app/api/v1/audit-logs/verify/route';
import { AuditAction } from '@/domain/audit/action';
import { costMicroUsd } from '@/domain/pricing';
import { AgentStatus, IncidentStatus, Provider, Role, RuleAction, RuleKind } from '@/domain/types';
import { call, seedEachTest } from './helpers';

// seed（2 テナント × 3 役割）。E2E はこの中の admin トークンで操作する
const seed = seedEachTest();

// 中継に使うモデル（料金表にある値）
const MODEL = 'claude-sonnet-4-6';
// スタブ上流の接続先（ループバックなので非本番では http を許す。fetch は差し替えるので繋がない）
const STUB_BASE_URL = 'http://127.0.0.1:4010';
// 監査ログの鍵（下限を満たす固定値。テスト専用で本番の鍵ではない）
const AUDIT_SECRET = 'guardrail-e2e-audit-secret-0123456789';
// 上流が返すトークン数（この 2 つから 1 回あたりの料金が決まる）
const INPUT_TOKENS = 100;
const OUTPUT_TOKENS = 200;
// 集計窓の長さ（分）。1 本のテストの中の中継はすべてこの窓に入る
const WINDOW_MINUTES = 60;

// 上流を 1 回分差し替える（毎回同じ正常応答を返す）
function stubUpstream(): void {
  // fetch の代わりに呼ばれる関数（本文は Anthropic 形式の最小形）
  const fake = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          id: 'msg_e2e',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: INPUT_TOKENS, output_tokens: OUTPUT_TOKENS },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
  // グローバルの fetch を差し替える
  vi.stubGlobal('fetch', fake);
}

beforeEach(() => {
  // 上流を模す
  stubUpstream();
  // 上流の接続先と資格情報はサーバ側の設定として与える（クライアントからは渡らない）
  vi.stubEnv('ANTHROPIC_BASE_URL', STUB_BASE_URL);
  vi.stubEnv('ANTHROPIC_API_KEY', 'upstream-anthropic-key');
  // 監査ログの鍵（無いと発火の記録が飛ばされる。停止自体は行われる）
  vi.stubEnv('AUDIT_HMAC_SECRET', AUDIT_SECRET);
});

afterEach(() => {
  // 差し替えを元へ戻す（別ファイルへ漏らさない）
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('ガードレールの E2E', () => {
  it('E2E: 登録→実行→超過→停止→復帰', async () => {
    // admin のログイントークン（登録・ルール設定・復帰・解決はすべて admin 限定）
    const admin = seed.a.tokens[Role.admin];

    // ── 1. 登録: エージェント・API キー・ガードレールのルール ──
    // エージェントを登録する
    const created = await call(createAgent, {
      token: admin,
      body: { name: 'E2E エージェント', provider: Provider.anthropic, model: MODEL },
    });
    // 201 で返り、最初は active
    expect(created.status).toBe(201);
    const agent = created.json as { id: string; status: string };
    expect(agent.status).toBe(AgentStatus.active);
    // そのエージェントに紐づく API キーを発行する（平文は発行応答でしか手に入らない）
    const keyIssued = await call(createApiKey, {
      token: admin,
      body: { name: 'E2E キー', agentId: agent.id },
    });
    // 201 で平文のキーが返る
    expect(keyIssued.status).toBe(201);
    const apiKey = (keyIssued.json as { secret: string }).secret;
    // **1 回あたりの料金を料金表から導く**（テストに金額を書き写さない）
    const perCall = costMicroUsd(Provider.anthropic, MODEL, INPUT_TOKENS, OUTPUT_TOKENS);
    // 料金表に無ければテストの前提が崩れているので落とす
    expect(perCall, '料金表から 1 回あたりの料金を引けない').not.toBeNull();
    // **しきい値は「1 回では超えないが 2 回で超える」額**にする（1 回ぶんちょうど）。
    // 判定は「超過したら発火」なので、合計がしきい値と等しい 1 回目では発火しない
    const threshold = Number(perCall);
    // コスト超過で**停止する**ルールを登録する
    const ruleCreated = await call(createGuardrailRule, {
      token: admin,
      body: {
        agentId: agent.id,
        kind: RuleKind.cost,
        threshold,
        windowMinutes: WINDOW_MINUTES,
        action: RuleAction.stop,
      },
    });
    // 201 で返り、有効な状態で作られる
    expect(ruleCreated.status).toBe(201);
    expect((ruleCreated.json as { enabled: boolean }).enabled).toBe(true);

    // ── 2. 実行: しきい値を超えない 1 回目の中継 ──
    // 発行したキーで中継する
    const firstRelay = await call(proxyAnthropic, {
      token: apiKey,
      body: { model: MODEL, messages: [] },
    });
    // 上流の応答がそのまま返る
    expect(firstRelay.status).toBe(200);
    // まだ超過していないので発火せず、エージェントは active のまま
    const afterFirst = await call(getAgent, {
      token: admin,
      params: { agentId: agent.id },
    });
    expect((afterFirst.json as { status: string }).status).toBe(AgentStatus.active);
    // インシデントも 0 件
    const noIncidents = await call(listIncidents, { token: admin });
    expect((noIncidents.json as { items: unknown[] }).items).toHaveLength(0);

    // ── 3. 超過: 2 回目の中継で合計がしきい値を超える ──
    // 2 回目（この中継自体は上流が成功しているので 200 が返る）
    const secondRelay = await call(proxyAnthropic, {
      token: apiKey,
      body: { model: MODEL, messages: [] },
    });
    // 中継の成否は判定とは独立（課金は発生したのだから応答は返す）
    expect(secondRelay.status).toBe(200);

    // ── 4. 停止: 自動で suspended になり、記録が残り、次の中継が断られる ──
    // 状態を読み直す
    const suspended = await call(getAgent, {
      token: admin,
      params: { agentId: agent.id },
    });
    // ガードレールによる自動停止なので suspended（手動停止の stopped とは区別する）
    expect((suspended.json as { status: string }).status).toBe(AgentStatus.suspended);
    // インシデントが 1 件 open で残っている
    const incidents = await call(listIncidents, { token: admin });
    const incidentItems = (incidents.json as { items: { id: string; status: string }[] }).items;
    expect(incidentItems).toHaveLength(1);
    expect(incidentItems[0].status).toBe(IncidentStatus.open);
    // 監査ログに発火が残っている（操作主体は自動発火なので null）
    const logs = await call(listAuditLogs, { token: admin });
    const logItems = (logs.json as { items: { action: string; actorId: string | null }[] }).items;
    expect(logItems.map((row) => row.action)).toContain(AuditAction.guardrail_fired);
    // 連鎖は無傷（改ざんされていない）
    const verified = await call(verifyAuditLogs, { token: admin });
    expect(verified.status).toBe(200);
    expect((verified.json as { ok: boolean }).ok).toBe(true);
    // 停止中は中継を断る（403。上流は呼ばれない）
    const blocked = await call(proxyAnthropic, {
      token: apiKey,
      body: { model: MODEL, messages: [] },
    });
    expect(blocked.status).toBe(403);

    // ── 5. 復帰: admin が戻すと中継が再び通り、インシデントを解決できる ──
    // 復帰させる（UC-09）
    const resumed = await call(resumeAgent, {
      token: admin,
      params: { agentId: agent.id },
    });
    // 200 で active に戻る
    expect(resumed.status).toBe(200);
    expect((resumed.json as { status: string }).status).toBe(AgentStatus.active);
    // **復帰後も同じ窓の合計は超過したまま**なので、次の中継で再び発火して止まる。
    // これは仕様どおり（窓が過ぎるか、しきい値を見直すまでは超過が続く）。
    // ここでは「復帰そのものが効いて中継が通る」ことだけを確かめるため、ルールを無効化せずに
    // 中継を 1 回行い、**403 ではなく 200 が返る**ことを見る
    const afterResume = await call(proxyAnthropic, {
      token: apiKey,
      body: { model: MODEL, messages: [] },
    });
    expect(afterResume.status).toBe(200);
    // インシデントを解決済みにする（人の操作。admin 限定）
    const resolved = await call(resolveIncident, {
      token: admin,
      method: 'POST',
      params: { incidentId: incidentItems[0].id },
    });
    // 200 で resolved になる
    expect(resolved.status).toBe(200);
    expect((resolved.json as { status: string }).status).toBe(IncidentStatus.resolved);
  });
});
