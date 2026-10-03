// ガードレール判定の入口（src/lib/guardrail/evaluate.ts）の検査。
// memory アダプタで組み立てるので DB は要らない。**上流も通知先も実際には呼ばない**
// （通知は fetch を差し替える）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRepos } from '@/data/adapters/memory';
import { MemoryStore } from '@/data/adapters/memory/store';
import type { Repositories } from '@/data/ports';
import { evaluateGuardrails, QUALITY_RULE_KINDS, USAGE_RULE_KINDS } from '@/lib/guardrail/evaluate';
import { AuditAction, AuditTargetType } from '@/domain/audit/action';
import { AUDIT_HMAC_SECRET_ENV } from '@/lib/audit/secret';
import { NOTIFY_SIGNING_SECRET_ENV, NOTIFY_URL_ENV, NotifyChannel } from '@/lib/notify/send';
import {
  AgentStatus,
  EvaluationRunStatus,
  IncidentStatus,
  Provider,
  RuleAction,
  RuleKind,
} from '@/domain/types';
import { GUARDRAIL_ERROR_RATE_MIN_REQUESTS } from '@/domain/guardrail/rule';

// 監査ログの鍵（下限を満たす固定値）
const AUDIT_SECRET = 'evaluate-test-audit-secret-0123456789';
// 通知の署名鍵（下限を満たす固定値）
const NOTIFY_SECRET = 'evaluate-test-notify-secret-012345678';
// 通知の宛先（https のスタブ）
const WEBHOOK_URL = 'https://hooks.example.com/guardrail';
// エージェントが使うモデル名
const MODEL = 'claude-sonnet-4-6';
/**
 * 判定の基準時刻（集計窓の終端。含まない）。
 *
 * **固定日にはできない。** memory アダプタの `record` は作成日時を表の時計（＝実時刻）で入れるので、
 * 基準時刻を過去の固定日にすると、直前に記録したイベントが窓の外（終端より後）に落ちて
 * どのルールも発火しなくなる（実測で 7 件が落ちた）。少し先の時刻を使い、直前の記録が
 * 「過去 N 分」に必ず入るようにする。絶対時刻に依存する検査はこのファイルに無い
 */
function basisTime(): Date {
  // 1 秒先（記録した時刻より確実に後ろ）
  return new Date(Date.now() + 1_000);
}
// 全種別（明示実行と同じ見方）
const ALL_KINDS = [RuleKind.cost, RuleKind.error_rate, RuleKind.quality] as const;

// 環境変数を組み立てる（NODE_ENV は ProcessEnv で必須）
function env(values: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  // 既定は「監査の鍵あり・通知は Webhook だけ設定済み」
  return {
    NODE_ENV: 'test',
    [AUDIT_HMAC_SECRET_ENV]: AUDIT_SECRET,
    [NOTIFY_URL_ENV[NotifyChannel.webhook]]: WEBHOOK_URL,
    [NOTIFY_SIGNING_SECRET_ENV]: NOTIFY_SECRET,
    ...values,
  } as NodeJS.ProcessEnv;
}

describe('ガードレールの判定', () => {
  // 表とリポジトリ（テストごとに作り直す）
  let store: MemoryStore;
  let repos: Repositories;
  // テナントとエージェントの id
  let tenantId: string;
  let agentId: string;

  beforeEach(async () => {
    // 新しい表で組み立てる
    store = new MemoryStore();
    repos = createMemoryRepos(store);
    // 通知のログを黙らせる（宛先の設定ミスを試す検査で意図的にログが出る）
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // テナントと初期 admin
    const created = await repos.tenants.createWithAdmin({
      name: 'テナント',
      admin: { email: 'admin@example.com', name: '管理者' },
      token: {
        prefix: 'aop_u_test',
        tokenHash: 'hash',
        name: '初期',
        expiresAt: new Date('2099-01-01T00:00:00Z'),
      },
    });
    tenantId = created.tenant.id;
    // 判定対象のエージェント
    const agent = await repos.agents.create({
      tenantId,
      name: 'bot',
      description: null,
      provider: Provider.anthropic,
      model: MODEL,
      budgetMicroUsd: null,
    });
    agentId = agent.id;
  });

  // スタブを片付ける
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ルールを 1 件作る
  async function makeRule(
    kind: RuleKind,
    threshold: number,
    action: RuleAction,
    windowMinutes = 60,
  ) {
    // 作成する（上限はこの検査の主題ではないので十分大きい値）
    const created = await repos.guardrailRules.create(
      { tenantId, agentId, kind, threshold, windowMinutes, action },
      { maxEnabled: 50, maxRows: 200 },
    );
    // 作れていなければ続けられない
    if (created.status !== 'created') throw new Error(`ルールを作れません: ${created.status}`);
    return created.rule;
  }

  // 利用イベントを 1 件記録する（窓に入る時刻で入れる）
  async function recordUsage(costMicroUsd: bigint, statusCode = 200) {
    // 記録する（createdAt は表の時計 = 現在時刻なので、NOW より少し前の窓に入る）
    return repos.usageEvents.record({
      tenantId,
      agentId,
      provider: Provider.anthropic,
      model: MODEL,
      inputTokens: 1,
      outputTokens: 1,
      costMicroUsd,
      latencyMs: 1,
      statusCode,
    });
  }

  // 評価実行を 1 件入れる（品質ルールが読む相手）
  async function recordRun(score: number | null) {
    // 採点できたかどうかで status と平均の有無が決まる
    const scored = score !== null;
    // セットとケースを作る
    const set = await repos.evaluations.createSet({
      tenantId,
      name: `セット-${Math.random()}`,
      cases: [{ input: '入力', expected: null }],
    });
    // 実行を保存する
    return repos.evaluations.createRun({
      tenantId,
      agentId,
      setId: set.set.id,
      accuracy: score,
      safety: score,
      deviation: score,
      status: scored ? EvaluationRunStatus.completed : EvaluationRunStatus.failed,
      scoredCases: scored ? 1 : 0,
      excludedCases: scored ? 0 : 1,
      judgeProvider: Provider.anthropic,
      judgeModel: 'claude-haiku-4-5',
      results: [],
    });
  }

  // 通知の fetch を差し替える（受け取った本文を記録しつつ 204 を返す）
  function stubNotify(onSend?: (body: unknown) => void) {
    // 送られた本文
    const sent: unknown[] = [];
    // fetch を差し替える
    vi.stubGlobal('fetch', async (_url: string | URL, init: RequestInit = {}) => {
      // 本文を解釈して記録する
      const body = JSON.parse(String(init.body));
      sent.push(body);
      // 送信の瞬間に状態を観測できるようにする（順序の検査に使う）
      onSend?.(body);
      // 受け手は 204 を返す
      return new Response(null, { status: 204 });
    });
    // 記録を呼び出し側へ渡す
    return sent;
  }

  it('ルールが 1 件も無ければ集計もしない', async () => {
    // **ルールを設定していないテナントの中継に集計の費用を掛けない**のが要点。
    // 落とせるのは「測定を先読みする」形の退行 — ループの外で窓を集計すると、
    // ルールが 0 件でも集計が走る。**早期 return の有無は落とせない**（0 件ならループが
    // 1 周もしないので、あっても無くても集計は走らない。実測で確かめた）
    const windowTotals = vi.spyOn(repos.usageEvents, 'windowTotals');
    // 判定する
    const result = await evaluateGuardrails(
      repos,
      { tenantId, agentId, kinds: ALL_KINDS, now: basisTime(), actorId: null },
      env(),
    );
    // 1 件も判定していない
    expect(result).toEqual({ evaluated: 0, fired: [] });
    // 集計も評価実行の読み出しも 1 度も呼ばれていない
    expect(windowTotals).not.toHaveBeenCalled();
  });

  it('見る種別が空なら問い合わせもしない', async () => {
    // ルールはあるが種別を指定していない
    await makeRule(RuleKind.cost, 1, RuleAction.stop);
    const findActiveRules = vi.spyOn(repos.guardrailRules, 'findActiveRules');
    // 判定する
    const result = await evaluateGuardrails(
      repos,
      { tenantId, agentId, kinds: [], now: basisTime(), actorId: null },
      env(),
    );
    // ルールの取得すら呼ばない
    expect(result.evaluated).toBe(0);
    expect(findActiveRules).not.toHaveBeenCalled();
  });

  it('コスト超過の stop ルールはインシデントを記録してエージェントを停止する', async () => {
    // しきい値 1,000 マイクロ USD に対して 1,500 使う
    const rule = await makeRule(RuleKind.cost, 1_000, RuleAction.stop);
    await recordUsage(1_500n);
    stubNotify();
    // 判定する
    const result = await evaluateGuardrails(
      repos,
      { tenantId, agentId, kinds: USAGE_RULE_KINDS, now: basisTime(), actorId: null },
      env(),
    );
    // 1 件判定して 1 件発火した
    expect(result.evaluated).toBe(1);
    expect(result.fired).toHaveLength(1);
    expect(result.fired[0]).toMatchObject({
      ruleId: rule.id,
      kind: RuleKind.cost,
      action: RuleAction.stop,
      suspended: true,
    });
    // エージェントが停止している
    expect((await repos.agents.findById(tenantId, agentId))?.status).toBe(AgentStatus.suspended);
    // インシデントが 1 件できて、要約に実測値としきい値が入っている
    const incident = await repos.incidents.findById(tenantId, result.fired[0]!.incidentId);
    expect(incident?.status).toBe(IncidentStatus.open);
    expect(incident?.summary).toContain('1500');
    expect(incident?.summary).toContain('1000');
  });

  it('notify ルールは記録するが停止しない', async () => {
    // action が notify のルール
    await makeRule(RuleKind.cost, 1_000, RuleAction.notify);
    await recordUsage(1_500n);
    stubNotify();
    // 判定する
    const result = await evaluateGuardrails(
      repos,
      { tenantId, agentId, kinds: USAGE_RULE_KINDS, now: basisTime(), actorId: null },
      env(),
    );
    // 発火はするが停止はしない
    expect(result.fired[0]?.suspended).toBe(false);
    expect((await repos.agents.findById(tenantId, agentId))?.status).toBe(AgentStatus.active);
  });

  it('しきい値ちょうどでは発火しない', async () => {
    // しきい値と同額
    await makeRule(RuleKind.cost, 1_000, RuleAction.stop);
    await recordUsage(1_000n);
    // 判定する
    const result = await evaluateGuardrails(
      repos,
      { tenantId, agentId, kinds: USAGE_RULE_KINDS, now: basisTime(), actorId: null },
      env(),
    );
    // 判定はしたが発火していない
    expect(result).toMatchObject({ evaluated: 1, fired: [] });
    expect((await repos.agents.findById(tenantId, agentId))?.status).toBe(AgentStatus.active);
  });

  it('測れていないものは発火させない（呼び出し 0 件のエラー率・評価 0 件の品質）', async () => {
    // **使われていないエージェントが勝手に停止されるのを防ぐ**（fail-safe）
    await makeRule(RuleKind.error_rate, 0.1, RuleAction.stop);
    await makeRule(RuleKind.quality, 0.9, RuleAction.stop);
    // 利用イベントも評価実行も 1 件も無い状態で判定する
    const result = await evaluateGuardrails(
      repos,
      { tenantId, agentId, kinds: ALL_KINDS, now: basisTime(), actorId: null },
      env(),
    );
    // 2 件判定して 1 件も発火していない
    expect(result).toMatchObject({ evaluated: 2, fired: [] });
    expect((await repos.agents.findById(tenantId, agentId))?.status).toBe(AgentStatus.active);
  });

  it('同じ窓の長さのルールが複数あっても集計は 1 回だけ', async () => {
    // 「50% で通知、80% で停止」のような使い方が自然なので、ルールごとに問い合わせると
    // 中継 1 回あたりのクエリが件数ぶんに増える（§8 の N+1 回避）
    await makeRule(RuleKind.error_rate, 0.5, RuleAction.notify, 60);
    await makeRule(RuleKind.error_rate, 0.8, RuleAction.stop, 60);
    await makeRule(RuleKind.cost, 1_000, RuleAction.notify, 60);
    // 別の長さの窓は別に数える
    await makeRule(RuleKind.cost, 1_000, RuleAction.notify, 30);
    const windowTotals = vi.spyOn(repos.usageEvents, 'windowTotals');
    // 判定する
    await evaluateGuardrails(
      repos,
      { tenantId, agentId, kinds: USAGE_RULE_KINDS, now: basisTime(), actorId: null },
      env(),
    );
    // 窓の長さは 2 種類なので 2 回だけ（ルールは 4 件）
    expect(windowTotals).toHaveBeenCalledTimes(2);
  });

  it('品質ルールが複数あっても評価実行の読み出しは 1 回だけ', async () => {
    // 2 件の品質ルール
    await makeRule(RuleKind.quality, 0.9, RuleAction.notify);
    await makeRule(RuleKind.quality, 0.5, RuleAction.stop);
    await recordRun(0.4);
    stubNotify();
    const findLatest = vi.spyOn(repos.evaluations, 'findLatestCompletedRun');
    // 判定する
    const result = await evaluateGuardrails(
      repos,
      { tenantId, agentId, kinds: [RuleKind.quality], now: basisTime(), actorId: null },
      env(),
    );
    // 読み出しは 1 回だけ
    expect(findLatest).toHaveBeenCalledTimes(1);
    // 0.4 は 0.9 も 0.5 も下回るので 2 件とも発火する
    expect(result.fired).toHaveLength(2);
  });

  it('中継の直後は品質ルールを見ない（評価実行の表を引かない）', async () => {
    // **起点によって見る種別を絞る**のが要点。絞らないと中継 1 回ごとに評価実行の表まで引く
    // ことになり、しかも中継では品質は動かないので判定しても意味が無い
    await makeRule(RuleKind.cost, 1_000, RuleAction.notify);
    await makeRule(RuleKind.quality, 0.9, RuleAction.stop);
    await recordRun(0.1);
    await recordUsage(1_500n);
    stubNotify();
    const findLatest = vi.spyOn(repos.evaluations, 'findLatestCompletedRun');
    // 中継の直後と同じ種別で判定する
    const result = await evaluateGuardrails(
      repos,
      { tenantId, agentId, kinds: USAGE_RULE_KINDS, now: basisTime(), actorId: null },
      env(),
    );
    // 判定したのはコストの 1 件だけ（品質ルールは対象外）
    expect(result.evaluated).toBe(1);
    expect(result.fired.map((row) => row.kind)).toEqual([RuleKind.cost]);
    // 評価実行の表は 1 度も引いていない
    expect(findLatest).not.toHaveBeenCalled();
    // 品質ルールは stop だが、見ていないので停止もしていない
    expect((await repos.agents.findById(tenantId, agentId))?.status).toBe(AgentStatus.active);
  });

  it('超過が続いても記録と通知は増えない（重複排除）', async () => {
    // **これが無いと溢れる。** 超過は「しきい値を下げる・窓が過ぎる・使用量が減る」まで続くので、
    // 判定のたびにインシデント・監査ログ・通知が増える。notify のルールは停止しないので
    // 条件が自己収束せず、実測で明示実行 5 回がインシデント 5 件・監査行 5 件になった
    await makeRule(RuleKind.cost, 1_000, RuleAction.notify);
    await recordUsage(1_500n);
    const sent = stubNotify();
    // 同じ超過のまま 5 回判定する
    for (let round = 0; round < 5; round += 1) {
      const result = await evaluateGuardrails(
        repos,
        { tenantId, agentId, kinds: USAGE_RULE_KINDS, now: basisTime(), actorId: null },
        env(),
      );
      // 毎回「発火した」とは返る（判定の答えは隠さない）
      expect(result.fired).toHaveLength(1);
      // 新しい行を作ったのは 1 回目だけ
      expect(result.fired[0].created).toBe(round === 0);
    }
    // インシデント・監査ログ・通知はいずれも 1 件だけ
    expect(store.incidents.size).toBe(1);
    expect((await repos.auditLogs.readChain(tenantId, 100)).rows).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it('開いている間に復帰させたら、再び止めて記録も残す', async () => {
    // **停止は重複排除の対象にしない** — 抑えると「超過しているのに動いている」状態が残る。
    // 一方で「止めた」という出来事は記録すべきなので、監査ログと通知もそのときは出す
    await makeRule(RuleKind.cost, 1_000, RuleAction.stop);
    await recordUsage(1_500n);
    const sent = stubNotify();
    // 1 回目: 記録して停止
    const first = await evaluateGuardrails(
      repos,
      { tenantId, agentId, kinds: USAGE_RULE_KINDS, now: basisTime(), actorId: null },
      env(),
    );
    expect(first.fired[0]).toMatchObject({ created: true, suspended: true });
    // 人が復帰させる（インシデントは開いたまま）
    await repos.agents.setStatus(tenantId, agentId, AgentStatus.active);
    // 2 回目: 行は作らないが停止はやり直し、記録も通知も出る
    const second = await evaluateGuardrails(
      repos,
      { tenantId, agentId, kinds: USAGE_RULE_KINDS, now: basisTime(), actorId: null },
      env(),
    );
    expect(second.fired[0]).toMatchObject({ created: false, suspended: true });
    // インシデントは 1 件のまま、記録と通知は 2 件（止めた回数ぶん）
    expect(store.incidents.size).toBe(1);
    expect((await repos.auditLogs.readChain(tenantId, 100)).rows).toHaveLength(2);
    expect(sent).toHaveLength(2);
    // **2 通目の時刻はその発火の時刻**（インシデント行の作成時刻ではない）。
    // 行の時刻を送ると「数日前に起きた出来事の通知がいま届いた」ように見え、しかも本文の
    // 要約はこの発火の実測値なので、1 通の中で時刻と数字が別の出来事を指すことになる
    const incident = [...store.incidents.values()][0]!;
    // 送られた本文から時刻だけを取り出す（stubNotify は本文を unknown で貯める）
    const occurredAtOf = (index: number): string =>
      (sent[index] as { occurredAt: string }).occurredAt;
    expect(occurredAtOf(1)).not.toBe(incident.createdAt.toISOString());
    // 1 通目より後の時刻になっている（単調に進む）
    expect(new Date(occurredAtOf(1)).getTime() >= new Date(occurredAtOf(0)).getTime()).toBe(true);
  });

  it('発火は監査ログに判断の根拠付きで残る', async () => {
    // コスト超過で発火させる
    const rule = await makeRule(RuleKind.cost, 1_000, RuleAction.stop);
    await recordUsage(1_500n);
    stubNotify();
    // 判定する
    const result = await evaluateGuardrails(
      repos,
      { tenantId, agentId, kinds: USAGE_RULE_KINDS, now: basisTime(), actorId: null },
      env(),
    );
    // 監査ログを読む
    const { rows } = await repos.auditLogs.readChain(tenantId, 100);
    // 1 行だけ追記されている
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: AuditAction.guardrail_fired,
      targetType: AuditTargetType.incident,
      targetId: result.fired[0]!.incidentId,
      // 自動発火なので操作主体は居ない
      actorId: null,
    });
    // payload に判断の根拠が入る（料金は BigInt なので文字列）
    expect(rows[0]!.payload).toEqual({
      kind: RuleKind.cost,
      action: RuleAction.stop,
      threshold: rule.threshold,
      windowMinutes: rule.windowMinutes,
      observed: '1500',
      suspended: true,
    });
  });

  it('監査ログの鍵が未設定でも停止は行う（止める側を優先する）', async () => {
    // **向きが要点** — 鍵が無いときに中断すると「超過しても止まらない」状態になる。
    // 記録できなかったことはログに残し、停止そのものは必ず行う
    await makeRule(RuleKind.cost, 1_000, RuleAction.stop);
    await recordUsage(1_500n);
    stubNotify();
    // 鍵を外して判定する
    const result = await evaluateGuardrails(
      repos,
      { tenantId, agentId, kinds: USAGE_RULE_KINDS, now: basisTime(), actorId: null },
      env({ [AUDIT_HMAC_SECRET_ENV]: undefined }),
    );
    // 発火して停止している
    expect(result.fired[0]?.suspended).toBe(true);
    expect((await repos.agents.findById(tenantId, agentId))?.status).toBe(AgentStatus.suspended);
    // 監査ログだけが欠ける
    expect((await repos.auditLogs.readChain(tenantId, 100)).rows).toHaveLength(0);
  });

  it('通知は全件の記録と停止が終わってから送る', async () => {
    // **受け手の応答時間を「発火から停止まで」の計測に入れない**ための順序。
    //
    // **ルールが 1 件だけでは何も確かめられない。** `incidents.raise` は返る前に停止を
    // 済ませるので、ループの中でその場で送っても「送信時点で停止済み」は成立してしまう
    // （実測で、その場で送る変異が全 15 件緑のまま通った）。守りたいのは
    // **複数のルールが同時に発火したとき、1 件目の通知の往復で 2 件目の停止が遅れないこと**
    // なので、2 件発火させて「最初の通知の時点で 2 件とも記録済みか」を見る
    await makeRule(RuleKind.cost, 1_000, RuleAction.stop);
    await makeRule(RuleKind.error_rate, 0.5, RuleAction.stop);
    // 料金もエラー率も超える窓を作る。**エラー率は分母が
    // GUARDRAIL_ERROR_RATE_MIN_REQUESTS に届かないと発火しない**ので、その件数ぶん積む
    // （どれも 500 なので失敗率 100%、合計の料金もしきい値 1000 を超える）
    for (let index = 0; index < GUARDRAIL_ERROR_RATE_MIN_REQUESTS; index += 1) {
      await recordUsage(1_500n, 500);
    }
    // 最初の送信の時点で記録済みだったインシデントの件数
    let incidentsAtFirstSend: number | undefined;
    stubNotify(() => {
      // 1 通目のときだけ数える（表を直接見る）
      if (incidentsAtFirstSend === undefined) incidentsAtFirstSend = store.incidents.size;
    });
    // 判定する
    const result = await evaluateGuardrails(
      repos,
      { tenantId, agentId, kinds: USAGE_RULE_KINDS, now: basisTime(), actorId: null },
      env(),
    );
    // 2 件発火している（前提が崩れていたら以降の検査が何も言っていない）
    expect(result.fired).toHaveLength(2);
    // **1 通目を送る前に 2 件とも記録・停止が終わっている**
    expect(incidentsAtFirstSend).toBe(2);
  });

  it('通知の本文には要約と停止したかが入る', async () => {
    // エラー率で発火させる（最小の分母ぶん積んで全件失敗 = 100%）
    await makeRule(RuleKind.error_rate, 0.5, RuleAction.stop);
    for (let index = 0; index < GUARDRAIL_ERROR_RATE_MIN_REQUESTS; index += 1) {
      await recordUsage(0n, index % 2 === 0 ? 500 : 503);
    }
    const sent = stubNotify();
    // 判定する
    const result = await evaluateGuardrails(
      repos,
      { tenantId, agentId, kinds: USAGE_RULE_KINDS, now: basisTime(), actorId: null },
      env(),
    );
    // Webhook だけ設定しているので 1 通
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      tenantId,
      agentId,
      kind: RuleKind.error_rate,
      incidentId: result.fired[0]!.incidentId,
      suspended: true,
    });
  });

  it('既定では通知の完了まで待ってから戻る（明示実行の応答と対応させる）', async () => {
    // **待たない側を既定にすると、明示実行の API が「通知したかどうか不明」な応答を返す。**
    // 中継の経路だけが `detachNotifications: true` で待たない（理由は同項目のコメント）。
    // ここでは「戻った時点で通知が完了している」ことを固定する — 送信を始めたかではなく
    // 完了したかを見るので、`void` で投げ捨てる形に変えると落ちる
    await makeRule(RuleKind.cost, 1_000, RuleAction.notify);
    await recordUsage(1_500n);
    // 通知が完了したか
    let finished = false;
    // 受け手はひと呼吸おいてから応答する（同じティックで終わらせない）
    vi.stubGlobal('fetch', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      finished = true;
      return new Response(null, { status: 204 });
    });
    // 既定（待つ）で判定する
    await evaluateGuardrails(
      repos,
      { tenantId, agentId, kinds: USAGE_RULE_KINDS, now: basisTime(), actorId: null },
      env(),
    );
    // 戻った時点で通知は終わっている
    expect(finished).toBe(true);
  });

  it('detachNotifications なら通知の完了を待たずに戻る', async () => {
    // 中継の経路が使う側。**受け手の応答時間を中継の遅延に乗せない**のが目的
    await makeRule(RuleKind.cost, 1_000, RuleAction.notify);
    await recordUsage(1_500n);
    // 完了したか
    let finished = false;
    // 解決を手元で握る（テストが完了させるまで終わらない）
    let finish = (): void => {};
    const sent = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.stubGlobal('fetch', async () => {
      await sent;
      finished = true;
      return new Response(null, { status: 204 });
    });
    // 待たない側で判定する
    await evaluateGuardrails(
      repos,
      {
        tenantId,
        agentId,
        kinds: USAGE_RULE_KINDS,
        now: basisTime(),
        actorId: null,
        detachNotifications: true,
      },
      env(),
    );
    // **戻った時点では通知が終わっていない**
    expect(finished).toBe(false);
    // 後始末: 完了させてから抜ける（浮いたままにしない）
    finish();
    await sent;
  });

  it('通知の受け手が落ちていても停止は取り消さない', async () => {
    // 通知だけが失敗する状況
    await makeRule(RuleKind.cost, 1_000, RuleAction.stop);
    await recordUsage(1_500n);
    // fetch が例外を投げる
    vi.stubGlobal('fetch', () => {
      throw new TypeError('fetch failed');
    });
    // 判定する（例外は外へ出ない）
    const result = await evaluateGuardrails(
      repos,
      { tenantId, agentId, kinds: USAGE_RULE_KINDS, now: basisTime(), actorId: null },
      env(),
    );
    // 停止は成立している
    expect(result.fired[0]?.suspended).toBe(true);
    expect((await repos.agents.findById(tenantId, agentId))?.status).toBe(AgentStatus.suspended);
  });

  it('他テナントのルールは判定に混ざらない', async () => {
    // 2 つ目のテナントに「必ず発火する」ルールを置く
    const other = await repos.tenants.createWithAdmin({
      name: 'ほか',
      admin: { email: 'b@example.com', name: 'B' },
      token: {
        prefix: 'aop_u_test',
        tokenHash: 'hash-b',
        name: '初期',
        expiresAt: new Date('2099-01-01T00:00:00Z'),
      },
    });
    await repos.guardrailRules.create(
      {
        tenantId: other.tenant.id,
        agentId: null,
        kind: RuleKind.cost,
        threshold: 0,
        windowMinutes: 60,
        action: RuleAction.stop,
      },
      { maxEnabled: 50, maxRows: 200 },
    );
    // 自テナントには料金の記録があるがルールは無い
    await recordUsage(1_500n);
    // 判定する
    const result = await evaluateGuardrails(
      repos,
      { tenantId, agentId, kinds: ALL_KINDS, now: basisTime(), actorId: null },
      env(),
    );
    // 他テナントのルールは見えないので 1 件も判定しない
    expect(result).toEqual({ evaluated: 0, fired: [] });
    expect((await repos.agents.findById(tenantId, agentId))?.status).toBe(AgentStatus.active);
  });
});

describe('起点ごとに見る種別の表', () => {
  it('2 つの表を合わせると RuleKind を全網羅する（結線漏れを落とす）', () => {
    // **種別を足して起点へ結線し忘れると、そのルールは作れるのに永久に発火しない**
    // （fail-open）。判定そのものは動くので、どのテストも緑のまま通ってしまう。
    // `RuleKind` から導いて照合するので、足した人はどちらかの表に入れるまで赤になる
    const wired = new Set<string>([...USAGE_RULE_KINDS, ...QUALITY_RULE_KINDS]);
    // enum の全値（正準は src/domain/types.ts）
    expect([...wired].sort()).toEqual([...Object.values(RuleKind)].sort());
  });

  it('2 つの表は重ならない（同じ種別を 2 つの起点が判定しない）', () => {
    // 重なると同じ超過で 2 件のインシデントが立ち、通知も 2 通になる
    const overlap = USAGE_RULE_KINDS.filter((kind) => QUALITY_RULE_KINDS.includes(kind));
    expect(overlap).toEqual([]);
  });
});
