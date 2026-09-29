// Step3 の受け入れ基準「固定評価セット 100 件で採点の再現率 ≧ 90%」を実測するベンチ。
//   DATABASE_URL='postgresql://…/agent_ops_contract?schema=app' npm run bench:evaluation
//
// 測り方 (「再現率」の定義は src/domain/evaluation/scores.ts の agreementRate が唯一の場所):
//   1. ローカルにスタブ上流を立てる。**実際の Anthropic / OpenAI は呼ばない** (課金も API キーも不要)
//   2. 100 件の評価セットを作り、同じセットを 2 回評価して結果を DB へ保存する
//   3. 保存した 2 回分を読み直し、ケースごとに同じ採点になったかを数える
//
// **スタブは意図的に揺れを注入する** (2 回目だけ違うスコアを返すケースを EVALUATION_BENCH_FLIPPED_CASES 件作る)。
// 決定論的なスタブでは一致率が必ず 100% になり、**計測そのものが何も検査しない**ため。
//
// **残る境界 (ADR-0009 にも書いてある)**: ここで確かめているのは「一致率の計算と、揺れの検出」で、
// **実 LLM の再現性ではない**。実モデルの揺れ幅は環境によって変わるので、CI では測れない
//
// スタブは **http のループバック** で立てる。プロキシの接続先の判定は「https、または非本番の
// ループバック http」なので、本番ビルドを使わないこのベンチではそのまま通る (証明書が要らない)
import 'dotenv/config';
import { createServer, type Server } from 'node:http';
import { runBench } from './lib/bench-criteria.mjs';
import { requireContractDatabase } from './lib/contract-database.mjs';
import {
  EVALUATION_BENCH_CASE_COUNT,
  EVALUATION_BENCH_FLIPPED_CASES,
  maxDisagreedCases,
} from './lib/step3-criteria.mjs';
import { createPrismaRepos } from '../src/data/adapters/prisma';
import { createPrismaClient } from '../src/lib/prisma-client';
import { agreementRate } from '../src/domain/evaluation/scores';
import type { CaseVerdict } from '../src/domain/evaluation/judge-output';
import { runEvaluation } from '../src/lib/evaluation/runner';
import { Plan, Provider } from '../src/domain/types';
import type { EvaluationResultRecord } from '../src/data/ports';

// 評価対象エージェントが使うモデル (料金表にある値。ベンチは料金を記録しないが本番と同じ綴りにする)
const AGENT_MODEL = 'claude-sonnet-4-6';
// judge が使うモデル
const JUDGE_MODEL = 'claude-haiku-4-5';
// 食い違ってよいケース数の上限 (受け入れ基準から整数の計算だけで導く。結果の JSON に載せる)
const LIMIT_DISAGREED_CASES = maxDisagreedCases(EVALUATION_BENCH_CASE_COUNT);
// 1 回目に返す採点 (全ケース共通)
const FIRST_SCORES = { accuracy: 0.8, safety: 1, deviation: 0.1 };
// 2 回目に「揺らす」ケースへ返す採点 (1 回目と別の値にする)
const FLIPPED_SCORES = { accuracy: 0.5, safety: 1, deviation: 0.1 };

// スタブ上流が受けた呼び出しの数え (経路を通ったことの証拠として結果に載せる)
interface UpstreamCounters {
  // エージェントの応答生成
  agent: number;
  // judge の採点
  judge: number;
}

// Anthropic 形式の応答本文を作る
function anthropicBody(text: string): string {
  // content 配列に text ブロックを 1 つ持つ形 (src/lib/llm/messages.ts が読む形)
  return JSON.stringify({ content: [{ type: 'text', text }], usage: {} });
}

// judge へ送られた本文から、依頼されたケース ID を読み取る
function requestedCaseIds(body: string): string[] {
  // user メッセージの 1 行目に「採点するケース: ...」がある (src/domain/evaluation/prompt.ts)
  const content = (JSON.parse(body) as { messages: { content: string }[] }).messages[0].content;
  return content.split('\n')[0].replace('採点するケース: ', '').split(', ');
}

// スタブ上流を立てる。**揺らすケースは「2 回目の採点だけ」違うスコアを返す**
function startStubUpstream(
  flipped: ReadonlySet<string>,
  counters: UpstreamCounters,
): Promise<{ server: Server; baseUrl: string }> {
  // そのケースを何回採点したか (2 回目かどうかの判定に使う)
  const judgedTimes = new Map<string, number>();
  // 受け取った本文を読んでから応答する HTTP サーバー
  const server = createServer((request, response) => {
    // 本文を溜める
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    // 本文を読み切ってから応答を決める
    request.on('end', () => {
      // 受け取った本文
      const body = Buffer.concat(chunks).toString('utf8');
      // judge の呼び出しだけが system を持つ (エージェントの呼び出しには無い)
      const isJudge = Object.hasOwn(JSON.parse(body) as Record<string, unknown>, 'system');
      // 応答本文を組み立てる
      let text: string;
      if (isJudge) {
        // judge の呼び出しを数える
        counters.judge += 1;
        // 依頼されたケースごとに採点を返す
        const results = requestedCaseIds(body).map((caseId) => {
          // そのケースの採点回数を進める
          const times = (judgedTimes.get(caseId) ?? 0) + 1;
          judgedTimes.set(caseId, times);
          // 揺らす対象の 2 回目だけ別のスコアにする
          const scores = flipped.has(caseId) && times >= 2 ? FLIPPED_SCORES : FIRST_SCORES;
          return { caseId, ...scores };
        });
        // judge が返す JSON をそのまま応答テキストにする
        text = JSON.stringify({ results });
      } else {
        // エージェントの呼び出しを数える
        counters.agent += 1;
        // 応答の中身は採点に影響しない (スタブの judge は固定のスコアを返す)
        text = 'ベンチ用の応答';
      }
      // Anthropic 形式で返す
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(anthropicBody(text));
    });
  });
  // 空きポートで待ち受け、接続先を返す
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      // 割り当てられたポート
      const address = server.address();
      // 読めなければ立てられていない (fail-closed)
      if (address === null || typeof address === 'string') {
        reject(new Error('スタブ上流のポートを取得できません'));
        return;
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

// 保存された採点結果を、一致率の判定が読む形へ戻す
function toVerdicts(results: readonly EvaluationResultRecord[]): CaseVerdict[] {
  // 行ごとに「採点できた」か「除外した」かへ写す (DB の CHECK 制約がどちらか一方を保証している)
  return results.map((row): CaseVerdict => {
    // 除外理由があれば除外
    if (row.excludedReason !== null) {
      return { caseId: row.caseId, scored: false, reason: row.excludedReason };
    }
    // スコアが揃っていなければ読めない行 (CHECK があるので通常は起きない。fail-closed)
    if (row.accuracy === null || row.safety === null || row.deviation === null) {
      throw new Error(`採点結果が壊れています (caseId: ${row.caseId})`);
    }
    // 採点できた行
    return {
      caseId: row.caseId,
      scored: true,
      scores: { accuracy: row.accuracy, safety: row.safety, deviation: row.deviation },
    };
  });
}

// ベンチ本体。**判定も出力も終了コードもここには書かない** — 受け入れ基準の強制は
// scripts/lib/bench-criteria.mjs の runBench に集約する (理由はそちら)
async function main(): Promise<Record<string, unknown>> {
  // 上流の呼び出し回数 (経路を通ったことの証拠)
  const counters: UpstreamCounters = { agent: 0, judge: 0 };
  // 本番と同じ結線でクライアントを作る
  const client = createPrismaClient();
  // 本番と同じアダプタ
  const repos = createPrismaRepos(client);
  // 揺らすケースの id はセットを作ってから決まるので、先に入れ物だけ用意する
  const flipped = new Set<string>();
  // スタブ上流を立てる
  const stub = await startStubUpstream(flipped, counters);
  // 後始末のために try で囲む
  try {
    // 全テーブルを空にする (値を埋め込まないタグ付きテンプレート)
    await client.$executeRaw`TRUNCATE TABLE "Tenant" CASCADE`;
    // 計測用のテナント
    const tenant = await client.tenant.create({ data: { name: 'ベンチ', plan: Plan.free } });
    // 計測用のエージェント
    const agent = await client.agent.create({
      data: {
        tenantId: tenant.id,
        name: 'ベンチ用',
        provider: Provider.anthropic,
        model: AGENT_MODEL,
      },
    });
    // 100 件の評価セット (入力はケースごとに変えて、応答の取り違えが起きたら分かるようにする)
    const set = await repos.evaluations.createSet({
      tenantId: tenant.id,
      name: 'ベンチ用の評価セット',
      cases: Array.from({ length: EVALUATION_BENCH_CASE_COUNT }, (_unused, index) => ({
        input: `ベンチの入力 ${index + 1}`,
        expected: null,
      })),
    });
    // 先頭から決まった件数を「2 回目に揺らす」対象にする
    for (const row of set.cases.slice(0, EVALUATION_BENCH_FLIPPED_CASES)) flipped.add(row.id);

    // 上流の接続先をスタブへ向ける (**process.env は書き換えず、この呼び出しにだけ渡す**)
    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: stub.baseUrl,
      ANTHROPIC_API_KEY: 'bench-stub-key',
    };
    // judge の結線 (環境変数ではなくここで直接指定する。測りたいのは採点の再現性なので)
    const judge = { provider: Provider.anthropic, model: JUDGE_MODEL };
    // 採点するケース (セットの並び順のまま)
    const casesToScore = set.cases.map((row) => ({
      caseId: row.id,
      input: row.input,
      expected: row.expected,
    }));

    // 1 回分を実行して保存し、保存された結果を返す
    const runOnce = async (): Promise<EvaluationResultRecord[]> => {
      // 評価を実行する (上流はスタブ)
      const outcome = await runEvaluation({
        agent: { provider: agent.provider, model: agent.model },
        judge,
        cases: casesToScore,
        env,
      });
      // 結果を保存する
      const saved = await repos.evaluations.createRun({
        tenantId: tenant.id,
        agentId: agent.id,
        setId: set.set.id,
        accuracy: outcome.totals.accuracy,
        safety: outcome.totals.safety,
        deviation: outcome.totals.deviation,
        status: outcome.status,
        scoredCases: outcome.totals.scoredCases,
        excludedCases: outcome.totals.excludedCases,
        judgeProvider: judge.provider,
        judgeModel: judge.model,
        results: outcome.verdicts.map((verdict) =>
          verdict.scored
            ? {
                caseId: verdict.caseId,
                accuracy: verdict.scores.accuracy,
                safety: verdict.scores.safety,
                deviation: verdict.scores.deviation,
                excludedReason: null,
              }
            : {
                caseId: verdict.caseId,
                accuracy: null,
                safety: null,
                deviation: null,
                excludedReason: verdict.reason,
              },
        ),
      });
      // 保存できなければ測っているものが違う (fail-closed)
      if (saved === null) throw new Error('評価実行を保存できませんでした');
      return saved.results;
    };

    // 同じセットを 2 回評価する
    const firstResults = await runOnce();
    const secondResults = await runOnce();
    // 判定へ渡す形へ戻す
    const first = toVerdicts(firstResults);
    const second = toVerdicts(secondResults);
    // 保存された結果から一致率を出す (判定の定義はドメイン層が持つ)
    const rate = agreementRate(first, second);
    // 突き合わせるケースが無ければ測れていない (fail-closed)
    if (rate === null) throw new Error('一致率を測れませんでした (採点結果が 1 件もありません)');
    // **突き合わせた実際のケース数**。定数をそのまま載せてはいけない —
    // 件数の判定 (benchCaseCountProblem) が定数どうしの比較になって恒真になり、
    // セットを縮めても「100 件で測った」と名乗れてしまう (食い違い件数の分母もずれる)
    const measuredCases = new Set([...first, ...second].map((verdict) => verdict.caseId)).size;
    // 食い違った件数 (ゲートの共通判定が「実測値 ≦ 上限」の形しか扱えないので件数で出す)
    const disagreedCases = Math.round((1 - rate) * measuredCases);
    // 計測結果を返す (受け入れ基準は runBench が表に従って掛ける)
    return {
      cases: measuredCases,
      flippedCases: flipped.size,
      upstreamRequests: counters.agent + counters.judge,
      agentRequests: counters.agent,
      judgeRequests: counters.judge,
      agreementPercent: Math.round(rate * 100),
      disagreedCases,
      limitDisagreedCases: LIMIT_DISAGREED_CASES,
    };
  } finally {
    // スタブ上流を閉じる (§8 リソースを確実に解放する)
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
    // 接続を閉じる
    await client.$disconnect();
  }
}

// **接続先が専用 DB かをここで確かめる** (開発 DB を TRUNCATE しない)。
// 判定と throw をまとめた関数をトップレベルの式文として呼ぶ (理由は他のベンチと同じ)
requireContractDatabase('bench:evaluation');

// 計測 → 判定 → 出力 → 終了コードを共有モジュールに任せて実行する
runBench('evaluation-agreement', main);
