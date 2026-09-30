// 評価セット・評価実行の契約テスト (実 PostgreSQL)。
// **memory アダプタでは見えないもの**をここで固定する:
//   - 複合 FK (tenantId, runId, setId) / (setId, caseId) が「別セットのケースを指す結果」を拒否すること
//   - マイグレーションで足した CHECK 制約 (採点と除外の排他・採点 0 件なら平均は null) が効くこと
//   - セット名の一意制約がテナント内に閉じていること
//   - 評価実行の履歴を持つエージェント・セットが Restrict で守られること
// RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で全テーブルを TRUNCATE するため開発 DB を指さない
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DuplicateError } from '@/data';
import type { EvaluationRunRecord, Repositories } from '@/data/ports';
import { EvaluationExclusionReason, EvaluationRunStatus, Provider } from '@/domain/types';
import { userTokenExpiresAt } from '@/lib/tokens';
import { runContractDatabaseGuard } from '../../scripts/lib/contract-database.mjs';

// 明示フラグが無ければ丸ごとスキップする
const ENABLED = process.env.RUN_PRISMA_CONTRACT === '1';

// テストで発行するトークンの有効期間 (日)
const TOKEN_TTL_DAYS = 1;
// エージェントが使うモデル名
const MODEL = 'claude-sonnet-4-6';

// テナント + エージェント + 評価セットを 1 組作る
async function makeTenantWithSet(repos: Repositories, label: string) {
  // テナントと初期 admin
  const created = await repos.tenants.createWithAdmin({
    name: `テナント${label}`,
    admin: { email: `admin-${label}@example.com`, name: `管理者${label}` },
    token: {
      prefix: 'aop_u_test',
      tokenHash: `hash-${label}-${Date.now()}-${Math.random()}`,
      name: '初期',
      expiresAt: userTokenExpiresAt(TOKEN_TTL_DAYS),
    },
  });
  // そのテナントのエージェント
  const agent = await repos.agents.create({
    tenantId: created.tenant.id,
    name: `bot-${label}`,
    description: null,
    provider: Provider.anthropic,
    model: MODEL,
    budgetMicroUsd: null,
  });
  // 2 件のケースを持つ評価セット
  const set = await repos.evaluations.createSet({
    tenantId: created.tenant.id,
    name: `セット${label}`,
    cases: [
      { input: '入力 1', expected: '期待 1' },
      { input: '入力 2', expected: null },
    ],
  });
  // まとめて返す
  return { tenantId: created.tenant.id, agent, set };
}

describe.skipIf(!ENABLED)('評価の契約', () => {
  // 実 DB のクライアントとリポジトリ (本番と同じ Composition Root 経由)
  let client: typeof import('@/lib/prisma').prisma;
  let repos: Repositories;

  // 接続する (生成物へ依存するモジュールはここで初めて読む)
  beforeAll(async () => {
    // 接続先が専用 DB であること (TRUNCATE する前に確かめる)
    runContractDatabaseGuard();
    const [{ prisma }, { getRepos }] = await Promise.all([
      import('@/lib/prisma'),
      import('@/data'),
    ]);
    client = prisma;
    repos = await getRepos();
  });

  // 全テーブルを空にする
  beforeEach(async () => {
    await client.$executeRaw`TRUNCATE TABLE "Tenant" CASCADE`;
  });

  it('セットはケースごと作られ、position 昇順で読み出せる', async () => {
    // テナントとセットを用意する
    const { tenantId, set } = await makeTenantWithSet(repos, 'a');
    // 作成時の戻り値が配列の順どおりであること
    expect(set.cases.map((row) => row.position)).toEqual([0, 1]);
    // 読み直しても同じ順序であること
    const found = await repos.evaluations.findSet(tenantId, set.set.id);
    expect(found?.cases.map((row) => row.input)).toEqual(['入力 1', '入力 2']);
  });

  it('セット名の一意はテナント内に閉じている', async () => {
    // 1 つ目のテナント
    const first = await makeTenantWithSet(repos, 'b');
    // 同じテナントに同じ名前で作ると弾かれる
    await expect(
      repos.evaluations.createSet({
        tenantId: first.tenantId,
        name: 'セットb',
        cases: [{ input: '入力', expected: null }],
      }),
    ).rejects.toBeInstanceOf(DuplicateError);
    // 別テナントなら同じ名前で作れる
    const second = await makeTenantWithSet(repos, 'c');
    const ok = await repos.evaluations.createSet({
      tenantId: second.tenantId,
      name: 'セットb',
      cases: [{ input: '入力', expected: null }],
    });
    expect(ok.set.name).toBe('セットb');
  });

  it('他テナントのセットは見えない', async () => {
    // 2 つのテナントを用意する
    const first = await makeTenantWithSet(repos, 'd');
    const second = await makeTenantWithSet(repos, 'e');
    // 片方の id をもう一方のテナントで引くと null (存在を隠す)
    expect(await repos.evaluations.findSet(second.tenantId, first.set.set.id)).toBeNull();
  });

  it('実行と結果が保存でき、他テナントからは見えない', async () => {
    // テナントとセットを用意する
    const { tenantId, agent, set } = await makeTenantWithSet(repos, 'f');
    // 1 件採点・1 件除外の実行を保存する
    const saved = await repos.evaluations.createRun({
      tenantId,
      agentId: agent.id,
      setId: set.set.id,
      accuracy: 0.8,
      safety: 0.9,
      deviation: 0.1,
      status: EvaluationRunStatus.completed,
      scoredCases: 1,
      excludedCases: 1,
      judgeProvider: Provider.anthropic,
      judgeModel: 'claude-haiku-4-5',
      results: [
        {
          caseId: set.cases[0].id,
          accuracy: 0.8,
          safety: 0.9,
          deviation: 0.1,
          excludedReason: null,
        },
        {
          caseId: set.cases[1].id,
          accuracy: null,
          safety: null,
          deviation: null,
          excludedReason: EvaluationExclusionReason.judge_unavailable,
        },
      ],
    });
    // 保存できていること
    expect(saved?.results).toHaveLength(2);
    // 読み直せること (結果はケースの position 昇順)
    const found = await repos.evaluations.findRun(tenantId, saved!.run.id);
    expect(found?.results.map((row) => row.excludedReason)).toEqual([
      null,
      EvaluationExclusionReason.judge_unavailable,
    ]);
    // 別テナントからは見えないこと
    const other = await makeTenantWithSet(repos, 'g');
    expect(await repos.evaluations.findRun(other.tenantId, saved!.run.id)).toBeNull();
  });

  it('別テナントのエージェント・セットを指す実行は保存できない (複合 FK)', async () => {
    // 2 つのテナントを用意する
    const first = await makeTenantWithSet(repos, 'h');
    const second = await makeTenantWithSet(repos, 'i');
    // 片方のテナント id で、もう一方のエージェントを指す実行は null になる
    expect(
      await repos.evaluations.createRun({
        tenantId: first.tenantId,
        agentId: second.agent.id,
        setId: first.set.set.id,
        accuracy: null,
        safety: null,
        deviation: null,
        status: EvaluationRunStatus.failed,
        scoredCases: 0,
        excludedCases: 1,
        judgeProvider: Provider.anthropic,
        judgeModel: 'claude-haiku-4-5',
        results: [],
      }),
    ).toBeNull();
    // 別テナントのセットを指す場合も同じ
    expect(
      await repos.evaluations.createRun({
        tenantId: first.tenantId,
        agentId: first.agent.id,
        setId: second.set.set.id,
        accuracy: null,
        safety: null,
        deviation: null,
        status: EvaluationRunStatus.failed,
        scoredCases: 0,
        excludedCases: 1,
        judgeProvider: Provider.anthropic,
        judgeModel: 'claude-haiku-4-5',
        results: [],
      }),
    ).toBeNull();
  });

  it('実行が使ったセットとは別のセットのケースを指す結果は保存できない (複合 FK)', async () => {
    // 同じテナントに 2 つのセットを作る
    const { tenantId, agent, set } = await makeTenantWithSet(repos, 'j');
    const otherSet = await repos.evaluations.createSet({
      tenantId,
      name: 'もう 1 つのセット',
      cases: [{ input: '別の入力', expected: null }],
    });
    // 実行はセット A を使うのに、結果はセット B のケースを指す
    expect(
      await repos.evaluations.createRun({
        tenantId,
        agentId: agent.id,
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

  it('採点と除外が両立する結果は CHECK 制約が拒否する', async () => {
    // テナントとセットを用意する
    const { tenantId, agent, set } = await makeTenantWithSet(repos, 'k');
    // スコアと除外理由を両方持つ結果を入れようとする (アプリ側の規律を抜けても DB が止める)
    await expect(
      repos.evaluations.createRun({
        tenantId,
        agentId: agent.id,
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
            caseId: set.cases[0].id,
            accuracy: 1,
            safety: 1,
            deviation: 0,
            excludedReason: EvaluationExclusionReason.missing_score,
          },
        ],
      }),
    ).rejects.toThrow();
  });

  it('採点 0 件なのに平均スコアがある実行は CHECK 制約が拒否する', async () => {
    // テナントとセットを用意する
    const { tenantId, agent, set } = await makeTenantWithSet(repos, 'l');
    // 「測れなかった」のに 0.0 を入れる形 (Step4 の品質低下ルールが誤発火する形) を DB が止める
    await expect(
      repos.evaluations.createRun({
        tenantId,
        agentId: agent.id,
        setId: set.set.id,
        accuracy: 0,
        safety: 0,
        deviation: 0,
        status: EvaluationRunStatus.failed,
        scoredCases: 0,
        excludedCases: 2,
        judgeProvider: Provider.anthropic,
        judgeModel: 'claude-haiku-4-5',
        results: [],
      }),
    ).rejects.toThrow();
  });

  it('評価実行の履歴を持つエージェントは削除できない (Restrict)', async () => {
    // テナントとセットを用意する
    const { tenantId, agent, set } = await makeTenantWithSet(repos, 'm');
    // 実行を 1 件保存する
    await repos.evaluations.createRun({
      tenantId,
      agentId: agent.id,
      setId: set.set.id,
      accuracy: null,
      safety: null,
      deviation: null,
      status: EvaluationRunStatus.failed,
      scoredCases: 0,
      excludedCases: 2,
      judgeProvider: Provider.anthropic,
      judgeModel: 'claude-haiku-4-5',
      results: [],
    });
    // 履歴があるので削除は restricted (停止 stop を使う)
    expect(await repos.agents.delete(tenantId, agent.id)).toBe('restricted');
  });

  it('直前の実行を同じエージェント × セットの中から引く', async () => {
    // テナントとセットを用意する
    const { tenantId, agent, set } = await makeTenantWithSet(repos, 'n');
    // 同じ組み合わせで 2 回実行する
    const runOnce = async (accuracy: number): Promise<EvaluationRunRecord> => {
      // 1 回分を保存して実行の行を返す
      const saved = await repos.evaluations.createRun({
        tenantId,
        agentId: agent.id,
        setId: set.set.id,
        accuracy,
        safety: 1,
        deviation: 0,
        status: EvaluationRunStatus.completed,
        scoredCases: 2,
        excludedCases: 0,
        judgeProvider: Provider.anthropic,
        judgeModel: 'claude-haiku-4-5',
        results: set.cases.map((row) => ({
          caseId: row.id,
          accuracy,
          safety: 1,
          deviation: 0,
          excludedReason: null,
        })),
      });
      // 保存できている前提 (できていなければテストとして落とす)
      expect(saved).not.toBeNull();
      return saved!.run;
    };
    // 1 回目と 2 回目
    const first = await runOnce(0.5);
    const second = await runOnce(0.9);
    // 2 回目から見た直前は 1 回目
    expect((await repos.evaluations.findPreviousRun(tenantId, second))?.id).toBe(first.id);
    // 1 回目から見た直前は無い (初回の実行)
    expect(await repos.evaluations.findPreviousRun(tenantId, first)).toBeNull();
  });

  it('failed の実行と別の judge の実行は直前の実行として選ばない', async () => {
    // テナントとセットを用意する
    const { tenantId, agent, set } = await makeTenantWithSet(repos, 'o');
    // 1 回分を保存して実行の行を返す (status と judge のモデル名を切り替えられるようにする)
    const runOnce = async (
      status: EvaluationRunStatus,
      judgeModel = 'claude-haiku-4-5',
    ): Promise<EvaluationRunRecord> => {
      // failed の実行は採点が 0 件なので平均は null (CHECK 制約と同じ規律)
      const scored = status === EvaluationRunStatus.completed;
      const saved = await repos.evaluations.createRun({
        tenantId,
        agentId: agent.id,
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
    };
    // completed → 別 judge の completed → failed → completed の順に 4 回実行する
    const oldest = await runOnce(EvaluationRunStatus.completed);
    await runOnce(EvaluationRunStatus.completed, 'claude-sonnet-4-6');
    await runOnce(EvaluationRunStatus.failed);
    const latest = await runOnce(EvaluationRunStatus.completed);
    // 最新から見た直前は**間に挟まった failed でも別 judge の実行でもなく**、その前の completed。
    // failed はスコアが null で差を出せず、別 judge の差は「エージェントが変わった」ことを示さない
    expect((await repos.evaluations.findPreviousRun(tenantId, latest))?.id).toBe(oldest.id);
  });

  it('同じケースの結果を 2 つ持つ実行は一意制約が拒否する', async () => {
    // テナントとセットを用意する
    const { tenantId, agent, set } = await makeTenantWithSet(repos, 'p');
    // 同じ caseId を 2 回載せる (@@unique([runId, caseId]))
    const caseId = set.cases[0].id;
    await expect(
      repos.evaluations.createRun({
        tenantId,
        agentId: agent.id,
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
    ).rejects.toThrow();
  });
});
