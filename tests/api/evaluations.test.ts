// 評価経路 (/api/v1/evaluation-sets, /api/v1/evaluations) の API テスト。
// 上流 (エージェント・judge) は fetch を差し替えて模す — **実際の Anthropic / OpenAI は呼ばない**（§11）。
//
// ここで固定するのは 4 つの系統:
//   1. セットの作成・一覧・詳細（テナント境界・名前重複・入力検証）
//   2. 実行の 2 段（エージェントの応答 → judge の採点）が記録として残ること
//   3. **不正出力の除外**が API の応答に理由つきで現れること
//   4. **フォールバック**（judge が落ちても実行の記録は残る）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GET as listEvaluationSets,
  POST as createEvaluationSet,
} from '@/app/api/v1/evaluation-sets/route';
import { GET as getEvaluationSet } from '@/app/api/v1/evaluation-sets/[setId]/route';
import { GET as listEvaluationRuns, POST as runEvaluation } from '@/app/api/v1/evaluations/route';
import { GET as getEvaluationRun } from '@/app/api/v1/evaluations/[runId]/route';
import {
  AgentStatus,
  EvaluationExclusionReason,
  EvaluationRunStatus,
  Provider,
  RuleAction,
  RuleKind,
} from '@/domain/types';
import {
  API_MESSAGES,
  EVALUATION_SET_MAX_CASES,
  GUARDRAIL_RULES_MAX_PER_TENANT,
} from '@/lib/constants';
import { call, seedEachTest } from './helpers';
import { AuditAction } from '@/domain/audit/action';
import { resetSharedRateLimiterForTesting } from '@/lib/api/rate-limit';

// seed (2 テナント × 3 役割 + 既存エージェント)
const seed = seedEachTest();

// スタブ上流の接続先 (ループバック。fetch は差し替えるので実際には繋がない)
const STUB_BASE_URL = 'http://127.0.0.1:4012';

// Anthropic 形式の応答を作る
function anthropicBody(text: string): string {
  // content 配列に text ブロックを 1 つ持つ形
  return JSON.stringify({ content: [{ type: 'text', text }], usage: {} });
}

// 本文が judge への採点依頼か (judge の呼び出しだけが system を持つ)
function isJudgeRequest(body: string): boolean {
  // system の有無で見分ける
  return Object.hasOwn(JSON.parse(body) as Record<string, unknown>, 'system');
}

// 送られた本文から、judge へ依頼されたケース ID を読み取る
function requestedCaseIds(body: string): string[] {
  // user メッセージの 1 行目に「採点するケース: ...」がある
  const content = (JSON.parse(body) as { messages: { content: string }[] }).messages[0].content;
  return content.split('\n')[0].replace('採点するケース: ', '').split(', ');
}

// 上流の応答を決める関数を差し替える
function stubUpstream(respond: (body: string) => Response): void {
  // fetch を差し替える
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      respond(String(init?.body ?? '')),
    ),
  );
}

// judge が「依頼されたケースをそのまま満点で返す」正常な上流
function stubHealthyUpstream(): void {
  // judge には採点を、エージェントには応答を返す
  stubUpstream((body) =>
    isJudgeRequest(body)
      ? new Response(
          anthropicBody(
            JSON.stringify({
              results: requestedCaseIds(body).map((caseId) => ({
                caseId,
                accuracy: 1,
                safety: 1,
                deviation: 0,
              })),
            }),
          ),
          { status: 200 },
        )
      : new Response(anthropicBody('エージェントの応答'), { status: 200 }),
  );
}

// テナント a に評価セットを 1 つ作り、その詳細を返す
async function createSet(
  name = '基本セット',
  cases = [{ input: '入力 1' }, { input: '入力 2', expected: '期待 2' }],
) {
  // operator 権限で作る
  const created = await call(createEvaluationSet, {
    token: seed.a.tokens.operator,
    body: { name, cases },
  });
  // 作成できていること (失敗していれば理由が見えるよう本文ごと出す)
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  return created.json as { id: string; cases: { id: string }[] };
}

beforeEach(() => {
  // 上流の接続先と資格情報 (差し替えた fetch が受けるので外へは出ない)
  vi.stubEnv('ANTHROPIC_BASE_URL', STUB_BASE_URL);
  vi.stubEnv('ANTHROPIC_API_KEY', 'upstream-anthropic-key');
  // 失敗経路はサーバログへ出るので、テスト出力を汚さないよう黙らせる
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  // 差し替えを戻す
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('評価セット', () => {
  it('作成するとケースが配列の順で並び、詳細でも同じ順序で読める', async () => {
    // 2 件のケースを持つセットを作る
    const set = await createSet();
    // 詳細を引く
    const detail = await call(getEvaluationSet, {
      token: seed.a.tokens.viewer,
      params: { setId: set.id },
    });
    // 並び順と中身が保たれていること
    expect(detail.status).toBe(200);
    const body = detail.json as { cases: { position: number; input: string; expected: null }[] };
    expect(body.cases.map((row) => row.position)).toEqual([0, 1]);
    expect(body.cases[0].input).toBe('入力 1');
    // 期待する出力を省略したケースは null で返ること (未設定の表現を 1 つにする)
    expect(body.cases[0].expected).toBeNull();
  });

  it('同じテナントで名前が重複すると 422', async () => {
    // 1 つ目を作る
    await createSet('重複するセット');
    // 同じ名前で作る
    const again = await call(createEvaluationSet, {
      token: seed.a.tokens.operator,
      body: { name: '重複するセット', cases: [{ input: '入力' }] },
    });
    // 一意制約違反は 422 に翻訳される
    expect(again.status).toBe(422);
  });

  it('ケースが 0 件・上限超過はどちらも 422', async () => {
    // 0 件
    const empty = await call(createEvaluationSet, {
      token: seed.a.tokens.operator,
      body: { name: '空のセット', cases: [] },
    });
    expect(empty.status).toBe(422);
    // 上限 + 1 件
    const tooMany = await call(createEvaluationSet, {
      token: seed.a.tokens.operator,
      body: {
        name: '大きすぎるセット',
        cases: Array.from({ length: EVALUATION_SET_MAX_CASES + 1 }, () => ({ input: '入力' })),
      },
    });
    expect(tooMany.status).toBe(422);
  });

  it('他テナントのセットは 404 で隠す', async () => {
    // テナント a のセット
    const set = await createSet('a のセット');
    // テナント b の admin で引く
    const detail = await call(getEvaluationSet, {
      token: seed.b.tokens.admin,
      params: { setId: set.id },
    });
    // 403 ではなく 404 (存在を漏らさない)
    expect(detail.status).toBe(404);
    // 一覧にも出ない
    const list = await call(listEvaluationSets, { token: seed.b.tokens.admin });
    expect((list.json as { items: unknown[] }).items).toHaveLength(0);
  });
});

describe('評価の実行', () => {
  it('2 段（応答 → 採点）が通り、結果が記録として残る', async () => {
    // 正常な上流
    stubHealthyUpstream();
    // セットを作って実行する
    const set = await createSet('実行するセット');
    const run = await call(runEvaluation, {
      token: seed.a.tokens.operator,
      body: { agentId: seed.a.agent.id, setId: set.id },
    });
    // 201 で、2 件とも採点できていること
    expect(run.status, JSON.stringify(run.json)).toBe(201);
    const body = run.json as {
      id: string;
      status: string;
      scoredCases: number;
      accuracy: number;
      results: { caseId: string; excludedReason: string | null }[];
      regression: unknown;
    };
    expect(body.status).toBe(EvaluationRunStatus.completed);
    expect(body.scoredCases).toBe(2);
    expect(body.accuracy).toBe(1);
    // 初回なので比較相手が無い
    expect(body.regression).toBeNull();
    // 詳細でも同じ結果が読めること
    const detail = await call(getEvaluationRun, {
      token: seed.a.tokens.viewer,
      params: { runId: body.id },
    });
    expect((detail.json as { results: unknown[] }).results).toHaveLength(2);
  });

  it('2 回目の実行では直前との差が付く', async () => {
    // セットを作る
    const set = await createSet('回帰を見るセット');
    // 1 回目は満点
    stubHealthyUpstream();
    await call(runEvaluation, {
      token: seed.a.tokens.operator,
      body: { agentId: seed.a.agent.id, setId: set.id },
    });
    // 2 回目は低い点を返す judge にする
    stubUpstream((body) =>
      isJudgeRequest(body)
        ? new Response(
            anthropicBody(
              JSON.stringify({
                results: requestedCaseIds(body).map((caseId) => ({
                  caseId,
                  accuracy: 0.5,
                  safety: 1,
                  deviation: 0,
                })),
              }),
            ),
            { status: 200 },
          )
        : new Response(anthropicBody('エージェントの応答'), { status: 200 }),
    );
    const second = await call(runEvaluation, {
      token: seed.a.tokens.operator,
      body: { agentId: seed.a.agent.id, setId: set.id },
    });
    // 正確性が 1.0 → 0.5 に落ちたことが差として出ること
    const body = second.json as { regression: { accuracyDelta: number } | null };
    expect(body.regression?.accuracyDelta).toBe(-0.5);
  });

  it('除外: unknown_case_id — judge が幻覚 ID を返すと全件が除外理由つきで残る', async () => {
    // judge が依頼していないケース ID を混ぜる
    stubUpstream((body) =>
      isJudgeRequest(body)
        ? new Response(
            anthropicBody(
              JSON.stringify({
                results: [{ caseId: 'case_does_not_exist', accuracy: 1, safety: 1, deviation: 0 }],
              }),
            ),
            { status: 200 },
          )
        : new Response(anthropicBody('エージェントの応答'), { status: 200 }),
    );
    // セットを作って実行する
    const set = await createSet('幻覚 ID のセット');
    const run = await call(runEvaluation, {
      token: seed.a.tokens.operator,
      body: { agentId: seed.a.agent.id, setId: set.id },
    });
    // 実行は 201 で返り、全件が幻覚 ID を理由に除外されていること
    expect(run.status).toBe(201);
    const body = run.json as {
      status: string;
      scoredCases: number;
      accuracy: number | null;
      results: { excludedReason: string | null }[];
    };
    expect(body.results.map((row) => row.excludedReason)).toEqual([
      EvaluationExclusionReason.unknown_case_id,
      EvaluationExclusionReason.unknown_case_id,
    ]);
    // 1 件も採点できていないので平均は null (0.0 にしない)
    expect(body.scoredCases).toBe(0);
    expect(body.accuracy).toBeNull();
    // 除外が多すぎるので failed
    expect(body.status).toBe(EvaluationRunStatus.failed);
  });

  it('除外: judge_unavailable — judge が落ちても実行の記録は残る（フォールバック）', async () => {
    // エージェントは応答するが judge は 500
    stubUpstream((body) =>
      isJudgeRequest(body)
        ? new Response('{}', { status: 500 })
        : new Response(anthropicBody('エージェントの応答'), { status: 200 }),
    );
    // セットを作って実行する
    const set = await createSet('judge が落ちるセット');
    const run = await call(runEvaluation, {
      token: seed.a.tokens.operator,
      body: { agentId: seed.a.agent.id, setId: set.id },
    });
    // 500 を返さず 201 で「失敗した実行」を記録すること
    expect(run.status).toBe(201);
    const body = run.json as { id: string; status: string; results: { excludedReason: string }[] };
    expect(body.status).toBe(EvaluationRunStatus.failed);
    expect(
      body.results.every(
        (row) => row.excludedReason === EvaluationExclusionReason.judge_unavailable,
      ),
    ).toBe(true);
    // 一覧にも出ること (失敗した実行も履歴として残る)
    const list = await call(listEvaluationRuns, { token: seed.a.tokens.viewer });
    expect((list.json as { items: { id: string }[] }).items.map((row) => row.id)).toContain(
      body.id,
    );
  });

  it('除外: agent_unavailable — 応答が得られないケースだけが除外される', async () => {
    // 1 件目のエージェント呼び出しだけ落とす
    stubUpstream((body) => {
      if (isJudgeRequest(body)) {
        return new Response(
          anthropicBody(
            JSON.stringify({
              results: requestedCaseIds(body).map((caseId) => ({
                caseId,
                accuracy: 1,
                safety: 1,
                deviation: 0,
              })),
            }),
          ),
          { status: 200 },
        );
      }
      // 「入力 1」のケースだけ失敗させる
      if (body.includes('入力 1')) return new Response('{}', { status: 502 });
      return new Response(anthropicBody('エージェントの応答'), { status: 200 });
    });
    // セットを作って実行する
    const set = await createSet('片方だけ落ちるセット');
    const run = await call(runEvaluation, {
      token: seed.a.tokens.operator,
      body: { agentId: seed.a.agent.id, setId: set.id },
    });
    // 1 件目だけ除外、2 件目は採点できていること
    const body = run.json as {
      scoredCases: number;
      excludedCases: number;
      results: { excludedReason: string | null }[];
    };
    expect(body.results[0].excludedReason).toBe(EvaluationExclusionReason.agent_unavailable);
    expect(body.results[1].excludedReason).toBeNull();
    expect(body.scoredCases).toBe(1);
    expect(body.excludedCases).toBe(1);
  });

  it('停止中のエージェントは評価できない', async () => {
    // 正常な上流
    stubHealthyUpstream();
    // エージェントを停止させる
    const agent = seed.store.agents.get(seed.a.agent.id);
    if (agent !== undefined) agent.status = AgentStatus.stopped;
    // 実行しようとする
    const set = await createSet('停止中のセット');
    const run = await call(runEvaluation, {
      token: seed.a.tokens.operator,
      body: { agentId: seed.a.agent.id, setId: set.id },
    });
    // プロキシ経路と同じ 403 と文言
    expect(run.status).toBe(403);
    expect((run.json as { message: string }).message).toBe(API_MESSAGES.agentNotActive);
  });

  it('judge の設定が読めなければ 503（既定へ倒さない）', async () => {
    // 正常な上流だが judge のプロバイダ名が綴り間違い
    stubHealthyUpstream();
    vi.stubEnv('JUDGE_PROVIDER', 'anthropicc');
    // 実行しようとする
    const set = await createSet('設定ミスのセット');
    const run = await call(runEvaluation, {
      token: seed.a.tokens.operator,
      body: { agentId: seed.a.agent.id, setId: set.id },
    });
    // 意図しないプロバイダに採点させず 503 で止める
    expect(run.status).toBe(503);
    expect((run.json as { message: string }).message).toBe(API_MESSAGES.judgeNotConfigured);
  });

  it('judge の接続先が設定されていなければ 1 段目を走らせる前に 503', async () => {
    // 上流は正常に応答するが、judge のプロバイダの資格情報だけが無い
    stubHealthyUpstream();
    vi.stubEnv('JUDGE_PROVIDER', Provider.openai);
    vi.stubEnv('OPENAI_API_KEY', '');
    // 実行しようとする
    const set = await createSet('judge の鍵が無いセット');
    const run = await call(runEvaluation, {
      token: seed.a.tokens.operator,
      body: { agentId: seed.a.agent.id, setId: set.id },
    });
    // 設定が足りないので 503 (プロキシ経路の「設定が無い」と同じ扱い)
    expect(run.status).toBe(503);
    // **上流を 1 度も呼んでいないこと。** ここを通してしまうと、judge が使えないと分かるのは
    // 2 段目に入ってからで、それまでにケース数ぶんの応答生成 (= 課金) を払い切ってしまう
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('他テナントのエージェント・セットを指す実行は 404', async () => {
    // 正常な上流
    stubHealthyUpstream();
    // テナント a のセット
    const set = await createSet('a の実行セット');
    // テナント b のエージェントを指す
    const crossAgent = await call(runEvaluation, {
      token: seed.a.tokens.operator,
      body: { agentId: seed.b.agent.id, setId: set.id },
    });
    expect(crossAgent.status).toBe(404);
    // テナント b の operator が a のセットを指す
    const crossSet = await call(runEvaluation, {
      token: seed.b.tokens.operator,
      body: { agentId: seed.b.agent.id, setId: set.id },
    });
    expect(crossSet.status).toBe(404);
  });

  it('他テナントの実行は 404 で隠し、一覧にも出さない', async () => {
    // 正常な上流でテナント a が実行する
    stubHealthyUpstream();
    const set = await createSet('隠す実行のセット');
    const run = await call(runEvaluation, {
      token: seed.a.tokens.operator,
      body: { agentId: seed.a.agent.id, setId: set.id },
    });
    const runId = (run.json as { id: string }).id;
    // テナント b から引く
    const detail = await call(getEvaluationRun, {
      token: seed.b.tokens.admin,
      params: { runId },
    });
    expect(detail.status).toBe(404);
    // 一覧にも出ない
    const list = await call(listEvaluationRuns, { token: seed.b.tokens.admin });
    expect((list.json as { items: unknown[] }).items).toHaveLength(0);
  });

  it('一覧はエージェント・セットで絞れる', async () => {
    // 正常な上流で 1 回実行する
    stubHealthyUpstream();
    const set = await createSet('絞り込みのセット');
    await call(runEvaluation, {
      token: seed.a.tokens.operator,
      body: { agentId: seed.a.agent.id, setId: set.id },
    });
    // 一致する絞り込みでは出る
    const hit = await call(listEvaluationRuns, {
      token: seed.a.tokens.viewer,
      query: `agentId=${seed.a.agent.id}&setId=${set.id}`,
    });
    expect((hit.json as { items: unknown[] }).items).toHaveLength(1);
    // 別のセットで絞ると出ない
    const other = await createSet('別のセット');
    const miss = await call(listEvaluationRuns, {
      token: seed.a.tokens.viewer,
      query: `setId=${other.id}`,
    });
    expect((miss.json as { items: unknown[] }).items).toHaveLength(0);
  });
});

describe('評価の実行のレート制限', () => {
  // 検査用の小さい上限（本番の既定まで叩くのは遅い）。確かめたいのは「上限に達したら断る」挙動
  const TEST_LIMIT = 2;
  // 窓は 1 分（境界そのものは tests/rate-limit.test.ts が決定的に固定している）
  const TEST_WINDOW_MS = 60_000;

  // 各テストの前に小さい上限で作り直す（seedEachTest も作り直すので、この順で上書きする）
  beforeEach(() => {
    resetSharedRateLimiterForTesting({ limit: TEST_LIMIT, windowMs: TEST_WINDOW_MS });
  });

  it('上限を超えた実行は 429 で断り、上流を呼ばない', async () => {
    // **ここが制限を置いた目的** — 1 要求でケース数ぶんの課金対象の呼び出しが走るので、
    // 中継だけを守っても「評価を回す」側から同じ費用を発生させられる（実測で制限が無かった）
    stubHealthyUpstream();
    const set = await createSet();
    // 上限までは通る
    for (let index = 0; index < TEST_LIMIT; index += 1) {
      const ok = await call(runEvaluation, {
        token: seed.a.tokens.operator,
        body: { agentId: seed.a.agent.id, setId: set.id },
      });
      expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    }
    // ここまでの上流呼び出しの回数を覚える
    const callsBefore = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls
      .length;
    // 次は断られる
    const limited = await call(runEvaluation, {
      token: seed.a.tokens.operator,
      body: { agentId: seed.a.agent.id, setId: set.id },
    });
    expect(limited.status).toBe(429);
    // Retry-After は整数の秒数（RFC 9110 の delay-seconds）
    expect(limited.headers.get('Retry-After')).toMatch(/^\d+$/);
    // 文言は利用者向けの日本語
    expect(limited.json).toMatchObject({ message: API_MESSAGES.rateLimited });
    // **上流へは 1 度も出ていない**（先に実行してから断る実装では緑にならない）
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(
      callsBefore,
    );
  });
});

describe('評価実行の直後のガードレール判定', () => {
  // judge が「依頼されたケースを低いスコアで返す」上流（品質ルールを発火させる）
  function stubLowQualityUpstream(score: number): void {
    // judge には低いスコアを、エージェントには応答を返す
    stubUpstream((body) =>
      isJudgeRequest(body)
        ? new Response(
            anthropicBody(
              JSON.stringify({
                results: requestedCaseIds(body).map((caseId) => ({
                  caseId,
                  accuracy: score,
                  safety: score,
                  deviation: 0,
                })),
              }),
            ),
            { status: 200 },
          )
        : new Response(anthropicBody('エージェントの応答'), { status: 200 }),
    );
  }

  // 品質ルールを 1 件作る（発火したら停止する）
  async function makeQualityRule(threshold: number) {
    // そのエージェント向けのルール
    const created = await seed.repos.guardrailRules.create(
      {
        tenantId: seed.a.id,
        agentId: seed.a.agent.id,
        kind: RuleKind.quality,
        threshold,
        windowMinutes: 60,
        action: RuleAction.stop,
      },
      GUARDRAIL_RULES_MAX_PER_TENANT,
    );
    // 作れていなければテストとして落とす
    if (created.status !== 'created') throw new Error(`ルールを作れません: ${created.status}`);
  }

  // 監査ログの鍵を設定する
  beforeEach(() => {
    vi.stubEnv('AUDIT_HMAC_SECRET', 'evaluations-test-audit-secret-0123');
  });

  it('品質が下回ったら実行の直後に発火してエージェントを停止する', async () => {
    // **cron 間隔に依存せず、保存の直後に判定する**のが要点（UC-08）。
    // しきい値 0.9 に対して 0.2 で採点させる
    await makeQualityRule(0.9);
    stubLowQualityUpstream(0.2);
    const set = await createSet();
    // 実行する
    const result = await call(runEvaluation, {
      token: seed.a.tokens.operator,
      body: { agentId: seed.a.agent.id, setId: set.id },
    });
    // 実行そのものは成功して保存されている（201）
    expect(result.status, JSON.stringify(result.json)).toBe(201);
    // **応答を返した時点でもう停止している**
    expect(seed.store.agents.get(seed.a.agent.id)?.status).toBe(AgentStatus.suspended);
    // インシデントが 1 件できている
    expect(seed.store.incidents.size).toBe(1);
  });

  it('品質がしきい値を上回っていれば発火しない', async () => {
    // しきい値 0.5 に対して満点で採点させる
    await makeQualityRule(0.5);
    stubHealthyUpstream();
    const set = await createSet();
    // 実行する
    const result = await call(runEvaluation, {
      token: seed.a.tokens.operator,
      body: { agentId: seed.a.agent.id, setId: set.id },
    });
    expect(result.status).toBe(201);
    // 停止もインシデントも起きない
    expect(seed.store.agents.get(seed.a.agent.id)?.status).toBe(AgentStatus.active);
    expect(seed.store.incidents.size).toBe(0);
  });

  it('判定が失敗しても保存済みの実行を 500 で隠さない', async () => {
    // **実行はすでに保存されている**ので、判定の失敗で 500 にすると
    // 「保存された実行が利用者からは失敗に見える」ことになる
    await makeQualityRule(0.9);
    stubLowQualityUpstream(0.2);
    const set = await createSet();
    // ルールの取得が必ず失敗するようにする
    vi.spyOn(seed.repos.guardrailRules, 'findActiveRules').mockRejectedValue(
      new Error('DB が落ちている'),
    );
    // 実行する
    const result = await call(runEvaluation, {
      token: seed.a.tokens.operator,
      body: { agentId: seed.a.agent.id, setId: set.id },
    });
    // 201 のまま
    expect(result.status).toBe(201);
    // 判定できなかったので停止もしていない
    expect(seed.store.agents.get(seed.a.agent.id)?.status).toBe(AgentStatus.active);
  });

  it('発火は監査ログに「誰が起点か」付きで残る', async () => {
    // 自動発火だが起点は人の操作なので、評価を走らせたユーザーを操作主体として残す
    await makeQualityRule(0.9);
    stubLowQualityUpstream(0.2);
    const set = await createSet();
    await call(runEvaluation, {
      token: seed.a.tokens.operator,
      body: { agentId: seed.a.agent.id, setId: set.id },
    });
    // 監査ログが 1 行あり、operator が操作主体として入っている
    const rows = [...seed.store.auditLogs.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: AuditAction.guardrail_fired,
      actorId: seed.a.users.operator.id,
    });
  });
});
