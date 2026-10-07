// Step7 の受け入れ基準①「クリーン環境で `docker compose up` → 5 分以内にデモ動作」のうち、
// **Docker を使わずに回せる部分集合**を実測するベンチ。
//   DATABASE_URL='postgresql://…/agent_ops_contract?schema=app' npm run build && npm run bench:demo-ready
//
// **なぜ部分集合なのか（基準の解釈。ゲート運用ルール 4 に従い roadmap と ADR-0013 にも書く）.**
// 基準の文は `docker compose up` から数えるが、Docker デーモンが無い機械（この開発環境もそう）では
// ゲートが回らなくなる。そこで 2 つの経路で同じ上限を見る:
//   - CI の `docker-smoke` ジョブ: `up -d --build` の開始時刻から数えてデモの筋が通るまで。
//     **こちらが基準そのもの**（イメージのビルドとマイグレーション適用を含む）
//   - このベンチ: 本番ビルドを起こしてからデモの筋が通るまで。**ゲートが毎回確かめるのはこちら**
// 部分集合のほうが必ず速いので「ゲートが緑でも CI が赤」はありうる（逆は無い）。
//
// **測るのは時間だけではない。** 段を削って速くした計測は「デモが動いた」の証拠にならないので、
// 通った段の数・エージェントが一覧に出た件数も結果に載せ、`runBench` が同じ重みで判定する。
//
// **クリーン環境**を模すために、計測の前に全テーブルを空にする（`TRUNCATE "Tenant" CASCADE`）。
// 接続先が専用 DB であることはトップレベルのガードが確かめる。
import 'dotenv/config';
import { requireContractDatabase } from './lib/contract-database.mjs';
import { runBench } from './lib/bench-criteria.mjs';
import { DEMO_READY_MAX_MS } from './lib/step7-criteria.mjs';
import { DEMO_STEPS, freePort, runDemoFlow, startDemoApp } from './lib/demo-flow.mjs';
import { createPrismaClient } from '../src/lib/prisma-client';
import { issueSecret } from '../src/lib/tokens';

// 全テーブルを空にして「何も無い配備」を作る
async function resetDatabase(): Promise<void> {
  // 本番と同じ結線（接続文字列の解釈を 2 か所に書かない）
  const client = createPrismaClient();
  // 後始末のために try で囲む
  try {
    // 親を消せば子はカスケードで消える
    await client.$executeRaw`TRUNCATE TABLE "Tenant" CASCADE`;
  } finally {
    // 接続を閉じる（§8 リソースを確実に解放する）
    await client.$disconnect();
  }
}

// ベンチ本体。**判定も出力も終了コードも書かない**（受け入れ基準の強制は runBench が持つ）
async function main(): Promise<Record<string, unknown>> {
  // クリーン環境を作る
  await resetDatabase();
  // プラットフォーム管理者トークン（デモの入口。**使い捨てをここで作る** —
  // 開発機の .env の値を使うと、計測が本番相当の資格情報に依存する）
  const platformAdminToken = issueSecret('user').secret;
  // アプリが待ち受けるポート
  const port = await freePort();
  // 起動した子プロセス（後始末で止める）
  let app: Awaited<ReturnType<typeof startDemoApp>> | undefined;
  try {
    // **ここから時間を測る** — 「配備してからデモが動くまで」なので、起動待ちを含める
    const startedAt = Date.now();
    // 本番ビルドを起こして health が通るまで待つ
    app = await startDemoApp({ port, platformAdminToken });
    // デモの筋を 1 回通す（HTTP だけで行う。DB へ直接書いて仕込まない）
    const flow = await runDemoFlow({ baseUrl: `http://127.0.0.1:${port}`, platformAdminToken });
    // 所要時間
    const elapsedMs = Date.now() - startedAt;
    // 計測結果（受け入れ基準も門番も runBench がこの項目を読んで掛ける）
    return {
      elapsedMs,
      limitMs: DEMO_READY_MAX_MS,
      // **デモの筋として踏むべき段の数**（正本は demo-flow.mjs の DEMO_STEPS）
      expectedSteps: DEMO_STEPS.length,
      // 実際に通った段の数
      stepsCompleted: flow.steps.length,
      // 登録したエージェントが一覧に出た件数（書いたものが読めたことの裏打ち）
      agentsListed: flow.agentsListed,
      // 判定には使わないが、何を通したか読めるように残す
      steps: flow.steps,
      plan: flow.plan,
    };
  } finally {
    // アプリを止める（計測の成否に関わらず必ず）
    app?.kill('SIGKILL');
  }
}

// **接続先が専用 DB かをここで確かめる**（開発 DB を TRUNCATE しない）。
// トップレベルの式文として呼ぶ理由は bench-proxy.ts の同じ箇所のコメント
requireContractDatabase('bench:demo-ready');

// 計測 → 判定 → 出力 → 終了コードを共有モジュールに任せて実行する
runBench('demo-ready', main);
