// Step2 の受け入れ基準「1 万件投入で集計 SQL ≦ 1 秒」を実測するベンチ。
//   DATABASE_URL='postgresql://…/agent_ops_contract?schema=app' npm run bench:usage
// **開発 DB では走らない** — 全テーブルを TRUNCATE してから投入するので、契約テストと同じ
// 「専用 DB の名前 (末尾 _contract)」の判定を通らなければ 1 件も書かずに落ちる (fail-closed)
import 'dotenv/config';
import { aggregateLatencyProblem, requireNoProblem } from './lib/bench-criteria.mjs';
import { requireContractDatabase } from './lib/contract-database.mjs';
import { USAGE_AGGREGATE_MAX_MS, USAGE_AGGREGATE_ROW_COUNT } from './lib/step2-criteria.mjs';
import { createPrismaRepos } from '../src/data/adapters/prisma';
import { createPrismaClient } from '../src/lib/prisma-client';
import { Plan, Provider } from '../src/domain/types';

// 1 回の INSERT でまとめて入れる件数 (大きすぎるとパラメータ数の上限に当たる)
const INSERT_BATCH_SIZE = 1_000;
// 投入するイベントを散らす日数 (日次集計の行数がこの日数になる)
const SPREAD_DAYS = 90;
// 1 日のミリ秒数
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;
// 集計を測る回数 (最初の 1 回は接続や計画のぶんが乗るので、複数回のうち最も遅い値で判定する)
const MEASURE_ROUNDS = 3;
// 投入するイベントのモデル名 (料金表とは独立。集計は記録された値を足すだけ)
const MODEL = 'claude-sonnet-4-6';

// ベンチ本体
async function main(): Promise<void> {
  // 本番と同じ結線でクライアントを作る
  const client = createPrismaClient();
  // 本番と同じアダプタ (集計の SQL もここが持つ)
  const repos = createPrismaRepos(client);
  // 後始末のために try で囲む
  try {
    // 全テーブルを空にする (値を埋め込まないタグ付きテンプレート)
    await client.$executeRaw`TRUNCATE TABLE "Tenant" CASCADE`;
    // 計測用のテナント
    const tenant = await client.tenant.create({ data: { name: 'ベンチ', plan: Plan.free } });
    // 計測用のエージェント
    const agent = await client.agent.create({
      data: { tenantId: tenant.id, name: 'ベンチ用', provider: Provider.anthropic, model: MODEL },
    });
    // 期間の起点 (今日から SPREAD_DAYS 日前)
    const start = new Date(Date.now() - SPREAD_DAYS * MILLIS_PER_DAY);
    // 投入を開始した時刻
    const insertStartedAt = performance.now();
    // 1 万件をまとめて入れる
    for (let offset = 0; offset < USAGE_AGGREGATE_ROW_COUNT; offset += INSERT_BATCH_SIZE) {
      // このバッチで入れる件数 (最後のバッチは端数)
      const size = Math.min(INSERT_BATCH_SIZE, USAGE_AGGREGATE_ROW_COUNT - offset);
      // バッチぶんの行を組み立てる (日付を散らす)
      const rows = Array.from({ length: size }, (_unused, index) => {
        // 通し番号
        const sequence = offset + index;
        // 何日目のイベントにするか
        const day = sequence % SPREAD_DAYS;
        // その日の中の時刻もばらす
        const createdAt = new Date(start.getTime() + day * MILLIS_PER_DAY + sequence);
        // 1 行分
        return {
          tenantId: tenant.id,
          agentId: agent.id,
          provider: Provider.anthropic,
          model: MODEL,
          inputTokens: 100 + (sequence % 50),
          outputTokens: 200 + (sequence % 70),
          costMicroUsd: BigInt(1_000 + (sequence % 13)),
          latencyMs: 10 + (sequence % 5),
          statusCode: 200,
          createdAt,
        };
      });
      // まとめて挿入する
      await client.usageEvent.createMany({ data: rows });
    }
    // 投入にかかった時間 (基準ではないが、遅すぎれば環境の問題が分かる)
    const insertMs = Math.round(performance.now() - insertStartedAt);
    // 集計の期間 (投入した全期間を含む)
    const window = {
      start: new Date(start.getTime() - MILLIS_PER_DAY),
      endExclusive: new Date(Date.now() + MILLIS_PER_DAY),
    };
    // 各回の所要時間
    const durations: number[] = [];
    // 複数回測る
    for (let round = 0; round < MEASURE_ROUNDS; round += 1) {
      // 1 回分の計測
      const startedAt = performance.now();
      const totals = await repos.usageEvents.dailyTotals(tenant.id, window);
      durations.push(Math.round(performance.now() - startedAt));
      // 集計結果が空なら測っているものが違う (fail-closed)
      if (totals.length === 0) throw new Error('集計結果が空です (投入か期間の指定が誤っています)');
    }
    // 判定には最も遅い回を使う (たまたま速かった回で通さない)
    const slowestMs = Math.max(...durations);
    // 受け入れ基準の判定 (満たしていれば null)。**出力の passed もここから導く** —
    // 比較式を JSON 側へ書き写すと、判定だけを緩めたときに「passed: false を出して exit 0」に割れる
    const problem = aggregateLatencyProblem(slowestMs);
    // 結果を人にもゲートにも読める形で出す
    console.log(
      JSON.stringify({
        bench: 'usage-aggregate',
        rows: USAGE_AGGREGATE_ROW_COUNT,
        insertMs,
        durationsMs: durations,
        slowestMs,
        limitMs: USAGE_AGGREGATE_MAX_MS,
        passed: problem === null,
      }),
    );
    // 基準を超えていれば失敗として終わる (判定も throw も scripts/lib/bench-criteria.mjs が持つ)
    requireNoProblem(problem);
  } finally {
    // 接続を閉じる (§8 リソースを確実に解放する)
    await client.$disconnect();
  }
}

// **接続先が専用 DB かをここで確かめる** (開発 DB を TRUNCATE しない)。
// 判定と throw をまとめた関数を**トップレベルの式文として**呼ぶ — main の中で
// `const problem = …; if (problem !== null && 何か) throw` と書けると、条件を 1 つ足すだけで
// ガードが実質外れる (実測で 705 件すべて緑だった)。この形なら外すには呼び出しごと消すしかない
requireContractDatabase('bench:usage');

// 実行する (失敗は非 0 終了にする)
main().catch((error: unknown) => {
  // 理由を出して落ちる
  console.error('[bench:usage]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
