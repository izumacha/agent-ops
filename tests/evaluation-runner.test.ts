// 評価実行の進め方 (src/lib/evaluation/*) を固定する。上流は fetch を差し替えて模し、
// **実際の Anthropic / OpenAI は 1 度も呼ばない** (CLAUDE.md §11)。
//
// ここで固定するのは受け入れ基準「評価失敗時のフォールバック」— どの段が失敗しても
// ケース単位の除外に落として続行し、実行そのものは必ず結果を返す。
// **除外理由ごとのテスト名は `除外: <理由>` で始める** (ゲートがこの名前で網羅を見る)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveJudgeIdentity } from '@/lib/evaluation/judge';
import {
  mapWithConcurrency,
  runEvaluation,
  type EvaluationCaseInput,
} from '@/lib/evaluation/runner';
import { EvaluationExclusionReason, EvaluationRunStatus, Provider } from '@/domain/types';
import {
  EVALUATION_RESPONSE_MAX_CHARS,
  EVALUATION_TRUNCATION_MARK,
  JUDGE_DEFAULT_MODEL,
  JUDGE_DEFAULT_PROVIDER,
} from '@/lib/constants';

// スタブ上流の接続先 (ループバック。fetch は差し替えるので実際には繋がない)
const STUB_BASE_URL = 'http://127.0.0.1:4011';
// 評価対象エージェントの結線
const AGENT = { provider: Provider.anthropic, model: 'claude-sonnet-4-6' };
// judge の結線
const JUDGE = { provider: Provider.anthropic, model: JUDGE_DEFAULT_MODEL };

// 上流へ送られた本文 (順に溜める)
let sentBodies: string[] = [];

// Anthropic 形式の応答を作る
function anthropicBody(text: string): string {
  // content 配列に text ブロックを 1 つ持つ形
  return JSON.stringify({ content: [{ type: 'text', text }], usage: {} });
}

// ケースを n 件作る
function makeCases(count: number): EvaluationCaseInput[] {
  // case_1 から連番で作る
  return Array.from({ length: count }, (_, index) => ({
    caseId: `case_${index + 1}`,
    input: `入力 ${index + 1}`,
    expected: null,
  }));
}

// judge が返す正常な採点 (依頼されたケース ID をそのまま返す)
function judgeReply(caseIds: readonly string[]): string {
  // 全件を同じスコアで採点する
  return JSON.stringify({
    results: caseIds.map((caseId) => ({ caseId, accuracy: 1, safety: 1, deviation: 0 })),
  });
}

// 送られた本文から、judge へ依頼されたケース ID を読み取る
function requestedCaseIds(body: string): string[] {
  // 本文の user メッセージに「採点するケース: ...」の行がある
  const content = (JSON.parse(body) as { messages: { content: string }[] }).messages[0].content;
  const line = content.split('\n')[0];
  return line.replace('採点するケース: ', '').split(', ');
}

// 上流の応答を決める関数を差し替える (エージェント用と judge 用を本文で見分ける)
function stubUpstream(respond: (body: string) => Response | Promise<Response>): void {
  // fetch の差し替え
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      // 送られた本文を記録する
      const body = String(init?.body ?? '');
      sentBodies.push(body);
      // 呼び出し側が決めた応答を返す
      return respond(body);
    }),
  );
}

// 本文が judge への採点依頼か (システム指示が付いているのが judge 側)
function isJudgeRequest(body: string): boolean {
  // judge の呼び出しだけが system を持つ
  return Object.hasOwn(JSON.parse(body) as Record<string, unknown>, 'system');
}

// すべて正常に応答する上流を立てる
function stubHealthyUpstream(): void {
  // judge には採点を、エージェントには応答を返す
  stubUpstream((body) =>
    isJudgeRequest(body)
      ? new Response(anthropicBody(judgeReply(requestedCaseIds(body))), { status: 200 })
      : new Response(anthropicBody('エージェントの応答'), { status: 200 }),
  );
}

beforeEach(() => {
  // 送信記録を空にする
  sentBodies = [];
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

describe('並列度を絞った処理', () => {
  it('入力と同じ順序で結果を返す', async () => {
    // わざと後の要素ほど速く終わるようにする
    const results = await mapWithConcurrency([30, 20, 10], 3, async (ms, index) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return index;
    });
    // 完了順ではなく入力順で返ること
    expect(results).toEqual([0, 1, 2]);
  });

  it('同時に走る本数が指定を超えない', async () => {
    // 同時に走っている本数と、その最大値
    let running = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return null;
      },
    );
    // 上限を超えていないこと
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('並列度が 1 未満なら設定ミスとして落とす', async () => {
    // 0 だと 1 件も処理できない (黙って進まなくなるのを避ける)
    await expect(mapWithConcurrency([1], 0, async () => null)).rejects.toThrow('並列度');
  });
});

describe('judge の結線を環境変数から決める', () => {
  it('指定が無ければ定数の既定値を使う', () => {
    // 環境変数を置かない (NODE_ENV など既存の値は残したまま judge の指定だけを消す)
    expect(
      resolveJudgeIdentity({ ...process.env, JUDGE_PROVIDER: undefined, JUDGE_MODEL: undefined }),
    ).toEqual({
      provider: JUDGE_DEFAULT_PROVIDER,
      model: JUDGE_DEFAULT_MODEL,
    });
  });

  it('指定があればそれを使う', () => {
    // プロバイダとモデルを両方指定する
    expect(
      resolveJudgeIdentity({ ...process.env, JUDGE_PROVIDER: 'openai', JUDGE_MODEL: 'gpt-5-mini' }),
    ).toEqual({
      provider: Provider.openai,
      model: 'gpt-5-mini',
    });
  });

  it('知らないプロバイダ名は既定へ倒さず null にする', () => {
    // 綴り間違いで意図しないプロバイダに採点させないため (fail-closed)
    expect(resolveJudgeIdentity({ ...process.env, JUDGE_PROVIDER: 'anthropicc' })).toBeNull();
  });
});

describe('評価を 1 回実行する', () => {
  it('全件を採点できる', async () => {
    // 正常な上流
    stubHealthyUpstream();
    // 3 件のセットを評価する
    const outcome = await runEvaluation({ agent: AGENT, judge: JUDGE, cases: makeCases(3) });
    // 3 件とも採点でき、集計が付くこと
    expect(outcome.totals.scoredCases).toBe(3);
    expect(outcome.totals.excludedCases).toBe(0);
    expect(outcome.totals.accuracy).toBe(1);
    expect(outcome.status).toBe(EvaluationRunStatus.completed);
    // 判定は依頼した順で返ること
    expect(outcome.verdicts.map((v) => v.caseId)).toEqual(['case_1', 'case_2', 'case_3']);
  });

  it('除外: agent_unavailable — 応答が得られないケースだけを除外して続行する', async () => {
    // case_2 への呼び出しだけ 500 を返す
    stubUpstream((body) => {
      if (isJudgeRequest(body)) {
        return new Response(anthropicBody(judgeReply(requestedCaseIds(body))), { status: 200 });
      }
      // エージェントへの本文に「入力 2」が含まれていたら失敗させる
      if (body.includes('入力 2')) return new Response('{}', { status: 500 });
      return new Response(anthropicBody('エージェントの応答'), { status: 200 });
    });
    // 3 件のセットを評価する
    const outcome = await runEvaluation({ agent: AGENT, judge: JUDGE, cases: makeCases(3) });
    // case_2 だけが除外され、残りは採点できること
    expect(outcome.verdicts[1]).toEqual({
      caseId: 'case_2',
      scored: false,
      reason: EvaluationExclusionReason.agent_unavailable,
    });
    expect(outcome.totals.scoredCases).toBe(2);
    // 除外は 3 件中 1 件なので上限 (半分) を超えず completed
    expect(outcome.status).toBe(EvaluationRunStatus.completed);
  });

  it('除外: judge_unavailable — judge が落ちてもケース単位の除外に落として結果を返す', async () => {
    // エージェントは応答するが judge は 503
    stubUpstream((body) =>
      isJudgeRequest(body)
        ? new Response('{}', { status: 503 })
        : new Response(anthropicBody('エージェントの応答'), { status: 200 }),
    );
    // 2 件のセットを評価する
    const outcome = await runEvaluation({ agent: AGENT, judge: JUDGE, cases: makeCases(2) });
    // 全件が judge_unavailable で除外されること (例外は投げない)
    expect(
      outcome.verdicts.every(
        (v) => !v.scored && v.reason === EvaluationExclusionReason.judge_unavailable,
      ),
    ).toBe(true);
    // 平均は null のまま、実行は failed になる
    expect(outcome.totals.accuracy).toBeNull();
    expect(outcome.status).toBe(EvaluationRunStatus.failed);
  });

  it('除外: judge_unavailable — judge の接続先が未設定でも実行は結果を返す', async () => {
    // 資格情報を空にする (resolveUpstreamTarget が 503 を投げる経路)
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    stubHealthyUpstream();
    // 1 件のセットを評価する
    const outcome = await runEvaluation({ agent: AGENT, judge: JUDGE, cases: makeCases(1) });
    // 応答も採点も得られないので除外され、実行は failed で返ること (例外にしない)
    expect(outcome.verdicts[0].scored).toBe(false);
    expect(outcome.status).toBe(EvaluationRunStatus.failed);
  });

  it('除外が半分を超えた実行は failed になる', async () => {
    // 4 件中 3 件のエージェント応答を落とす
    stubUpstream((body) => {
      if (isJudgeRequest(body)) {
        return new Response(anthropicBody(judgeReply(requestedCaseIds(body))), { status: 200 });
      }
      if (/入力 [234]/.test(body)) return new Response('{}', { status: 500 });
      return new Response(anthropicBody('エージェントの応答'), { status: 200 });
    });
    // 4 件のセットを評価する
    const outcome = await runEvaluation({ agent: AGENT, judge: JUDGE, cases: makeCases(4) });
    // 3/4 が除外なので failed
    expect(outcome.totals.excludedCases).toBe(3);
    expect(outcome.status).toBe(EvaluationRunStatus.failed);
  });

  it('長すぎる応答は切り詰めてから judge へ渡す', async () => {
    // 上限を超える長さの応答を返す
    const long = 'あ'.repeat(EVALUATION_RESPONSE_MAX_CHARS + 100);
    stubUpstream((body) =>
      isJudgeRequest(body)
        ? new Response(anthropicBody(judgeReply(requestedCaseIds(body))), { status: 200 })
        : new Response(anthropicBody(long), { status: 200 }),
    );
    // 1 件のセットを評価する
    await runEvaluation({ agent: AGENT, judge: JUDGE, cases: makeCases(1) });
    // judge へ送られた本文に切り詰めの印があり、元の長さより短いこと
    const judgeBody = sentBodies.find((body) => isJudgeRequest(body));
    expect(judgeBody).toBeDefined();
    expect(judgeBody).toContain(EVALUATION_TRUNCATION_MARK);
    expect(judgeBody?.includes(long)).toBe(false);
  });

  it('ケースが 0 件なら上流を 1 度も呼ばない', async () => {
    // 正常な上流を立てておく
    stubHealthyUpstream();
    // 空のセットを評価する
    const outcome = await runEvaluation({ agent: AGENT, judge: JUDGE, cases: [] });
    // 呼び出しが起きないこと (無駄な課金を発生させない)
    expect(sentBodies).toHaveLength(0);
    expect(outcome.verdicts).toEqual([]);
  });
});
