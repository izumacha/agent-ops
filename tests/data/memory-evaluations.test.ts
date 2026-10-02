// memory アダプタの評価まわりのうち、**prisma 側では DB の制約が守っている規律**を
// こちら側でも同じ答えにすることを固定する。
//
// なぜ要るか: API テストは memory、契約テストは prisma を使うので、片方だけ緩いと
// 「API テストは緑なのに本番では保存できない (またはその逆)」という割れ方をする。
// しかも契約テストは RUN_PRISMA_CONTRACT=1 のときだけ走るため、普段の `npm run test` では
// 割れていること自体が見えない。ここは DB 無しで走る側の歯止め
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryRepos } from '@/data/adapters/memory';
import { MemoryStore } from '@/data/adapters/memory/store';
import type { EvaluationRunRecord, Repositories } from '@/data/ports';
import { EvaluationExclusionReason, EvaluationRunStatus, Provider } from '@/domain/types';

// エージェントが使うモデル名 (値そのものに意味は無い)
const MODEL = 'claude-sonnet-4-6';

describe('memory アダプタの評価', () => {
  // 毎回まっさらな表とリポジトリ
  let repos: Repositories;
  // テナント id (作ったテナントの id を入れる)
  let tenantId: string;
  // 評価対象エージェントの id
  let agentId: string;
  // 表そのもの (同じ時刻の並びを作るために直接触る)
  let store: MemoryStore;
  // 評価セット (ケースごと)
  let set: Awaited<ReturnType<Repositories['evaluations']['createSet']>>;

  beforeEach(async () => {
    // 表を作り直す (テストごとに独立させる)
    store = new MemoryStore();
    repos = createMemoryRepos(store);
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
    // 評価対象エージェント
    const agent = await repos.agents.create({
      tenantId,
      name: 'bot',
      description: null,
      provider: Provider.anthropic,
      model: MODEL,
      budgetMicroUsd: null,
    });
    agentId = agent.id;
    // 2 件のケースを持つ評価セット
    set = await repos.evaluations.createSet({
      tenantId,
      name: 'セット',
      cases: [
        { input: '入力 1', expected: '期待 1' },
        { input: '入力 2', expected: null },
      ],
    });
  });

  // 1 回分の実行を保存する (status と judge のモデル名を切り替えられるようにする)
  async function runOnce(
    status: EvaluationRunStatus,
    judgeModel = 'claude-haiku-4-5',
  ): Promise<EvaluationRunRecord> {
    // failed の実行は採点 0 件なので平均は null (prisma 側の CHECK 制約と同じ規律)
    const scored = status === EvaluationRunStatus.completed;
    const saved = await repos.evaluations.createRun({
      tenantId,
      agentId,
      setId: set.set.id,
      accuracy: scored ? 0.5 : null,
      safety: scored ? 1 : null,
      deviation: scored ? 0 : null,
      status,
      scoredCases: scored ? set.cases.length : 0,
      excludedCases: scored ? 0 : set.cases.length,
      judgeProvider: Provider.anthropic,
      judgeModel,
      results: set.cases.map((row) => ({
        caseId: row.id,
        accuracy: scored ? 0.5 : null,
        safety: scored ? 1 : null,
        deviation: scored ? 0 : null,
        excludedReason: scored ? null : EvaluationExclusionReason.judge_unavailable,
      })),
    });
    // 保存できている前提 (できていなければテストとして落とす)
    expect(saved).not.toBeNull();
    return saved!.run;
  }

  it('品質ルールが読む「最新の completed」は failed を飛ばして選ぶ', async () => {
    // **品質低下ルールの唯一の入力なので、両アダプタで同じ行を選ばないと本番だけ判定が変わる**
    // (対になる検査が tests/data/evaluations.contract.prisma.test.ts にある)。
    // failed を混ぜてはいけないのは、採点 0 件の実行はスコアが null で、
    // それを「品質が落ちた」と読むのが誤判定だから
    expect(await repos.evaluations.findLatestCompletedRun(tenantId, agentId)).toBeNull();
    // completed → failed の順に実行する
    const completed = await runOnce(EvaluationRunStatus.completed);
    await runOnce(EvaluationRunStatus.failed);
    // 最新の completed は間に挟まった failed ではなく、その前の completed
    expect((await repos.evaluations.findLatestCompletedRun(tenantId, agentId))?.id).toBe(
      completed.id,
    );
    // 別のエージェントの実行は選ばない (エージェントごとに判定するため)
    const other = await repos.agents.create({
      tenantId,
      name: 'bot-2',
      description: null,
      provider: Provider.anthropic,
      model: MODEL,
      budgetMicroUsd: null,
    });
    expect(await repos.evaluations.findLatestCompletedRun(tenantId, other.id)).toBeNull();
    // 他テナントから同じエージェント id を指しても見えない (テナント条件が効いている)
    expect(await repos.evaluations.findLatestCompletedRun('tn-other', agentId)).toBeNull();
  });

  it('同じ時刻の 2 件は id の大きい方を最新とする (並びが揺れない)', async () => {
    // **同じミリ秒に 2 件入ると createdAt だけでは前後が決まらない。**
    // id の比較を落とすと、どちらが「最新」になるかが表の走査順で決まって揺れ、
    // 品質ルールが読むスコアが同じ入力でも変わる
    const first = await runOnce(EvaluationRunStatus.completed);
    const second = await runOnce(EvaluationRunStatus.completed);
    // id の小さい方・大きい方 (辞書順。比較はこの順序で行われる)
    const [lowerId, higherId] = [first.id, second.id].sort();
    // 2 件の作成日時を同じ瞬間へ揃える (表を直接書き換える)
    const sameMoment = new Date('2026-10-02T00:00:00.000Z');
    // **表の並びを id の順と逆にする** — ここが要点。日時だけで並べる実装は Array.sort が
    // 安定なので表の並びをそのまま残し、「最後の要素」が id の小さい方になる。
    // 表の並びと id の順が一致していると、id の比較を落とした実装でも同じ答えになって
    // テストが何も確かめない (実測で素通りした)
    for (const id of [higherId, lowerId]) {
      // 既にある行を取り出す
      const row = store.evaluationRuns.get(id);
      // 無ければテストとして落とす
      if (!row) throw new Error(`実行の行が見つかりません: ${id}`);
      // いったん消してから入れ直して末尾へ移し、日時も揃える
      store.evaluationRuns.delete(id);
      store.evaluationRuns.set(id, { ...row, createdAt: sameMoment });
    }
    // 表の並びでは lowerId が最後に居るが、最新と選ばれるのは id の大きい方
    const latest = await repos.evaluations.findLatestCompletedRun(tenantId, agentId);
    expect(latest?.id).toBe(higherId);
  });

  it('実行が使ったセットの外のケースを指す結果は保存できない (prisma の複合 FK と同じ答え)', async () => {
    // 同じテナントにもう 1 つセットを作る
    const otherSet = await repos.evaluations.createSet({
      tenantId,
      name: 'もう 1 つのセット',
      cases: [{ input: '別の入力', expected: null }],
    });
    // 実行はセット A を使うのに、結果はセット B のケースを指す
    expect(
      await repos.evaluations.createRun({
        tenantId,
        agentId,
        setId: set.set.id,
        accuracy: 1,
        safety: 1,
        deviation: 0,
        status: EvaluationRunStatus.completed,
        scoredCases: 1,
        excludedCases: 0,
        judgeProvider: Provider.anthropic,
        judgeModel: 'claude-haiku-4-5',
        results: [
          {
            caseId: otherSet.cases[0].id,
            accuracy: 1,
            safety: 1,
            deviation: 0,
            excludedReason: null,
          },
        ],
      }),
    ).toBeNull();
  });

  it('存在しないケース ID を指す結果も保存できない', async () => {
    // どのセットにも無い id
    expect(
      await repos.evaluations.createRun({
        tenantId,
        agentId,
        setId: set.set.id,
        accuracy: null,
        safety: null,
        deviation: null,
        status: EvaluationRunStatus.failed,
        scoredCases: 0,
        excludedCases: 1,
        judgeProvider: Provider.anthropic,
        judgeModel: 'claude-haiku-4-5',
        results: [
          {
            caseId: 'case_does_not_exist',
            accuracy: null,
            safety: null,
            deviation: null,
            excludedReason: EvaluationExclusionReason.judge_unavailable,
          },
        ],
      }),
    ).toBeNull();
  });

  it('failed の実行は直前の実行として選ばない', async () => {
    // completed → failed → completed の順に 3 回実行する
    const oldest = await runOnce(EvaluationRunStatus.completed);
    await runOnce(EvaluationRunStatus.failed);
    const latest = await runOnce(EvaluationRunStatus.completed);
    // 最新から見た直前は**間に挟まった failed ではなく**、その前の completed
    expect((await repos.evaluations.findPreviousRun(tenantId, latest))?.id).toBe(oldest.id);
  });

  it('同じケースの結果が 2 つある実行は保存できない (prisma の一意制約と同じ答え)', async () => {
    // 同じ caseId を 2 回載せる (本番では @@unique([runId, caseId]) が止める)
    const caseId = set.cases[0].id;
    expect(
      await repos.evaluations.createRun({
        tenantId,
        agentId,
        setId: set.set.id,
        accuracy: 1,
        safety: 1,
        deviation: 0,
        status: EvaluationRunStatus.completed,
        scoredCases: 2,
        excludedCases: 0,
        judgeProvider: Provider.anthropic,
        judgeModel: 'claude-haiku-4-5',
        results: [
          { caseId, accuracy: 1, safety: 1, deviation: 0, excludedReason: null },
          { caseId, accuracy: 0, safety: 0, deviation: 1, excludedReason: null },
        ],
      }),
    ).toBeNull();
  });

  it('別の judge で採点した実行は比較相手にしない', async () => {
    // 先に別のモデルで採点した実行を作り、次に今回のモデルで採点する
    await runOnce(EvaluationRunStatus.completed, 'claude-sonnet-4-6');
    const latest = await runOnce(EvaluationRunStatus.completed, 'claude-haiku-4-5');
    // judge が違う実行との差は「エージェントが変わった」ことを示さないので相手にしない
    expect(await repos.evaluations.findPreviousRun(tenantId, latest)).toBeNull();
  });

  it('前が failed しか無ければ比較相手は無い', async () => {
    // failed を 1 件だけ挟んでから completed を実行する
    await runOnce(EvaluationRunStatus.failed);
    const latest = await runOnce(EvaluationRunStatus.completed);
    // 比べられる実行が無いので null (failed を代わりに返さない)
    expect(await repos.evaluations.findPreviousRun(tenantId, latest)).toBeNull();
  });
});
