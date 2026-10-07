// Step7 の受け入れ基準②「同時 100 リクエストでエラー率 < 1%」を実測するベンチ。
//   DATABASE_URL='postgresql://…/agent_ops_contract?schema=app' npm run build && npm run bench:concurrency
//
// 測り方:
//   1. クリーン環境を作り、デモの筋（`scripts/lib/demo-flow.mjs`）を 1 回通してテナント・
//      エージェント・ユーザートークンを用意する（**HTTP だけで仕込む** — DB へ直接書くと
//      「配備した成果物で動くか」を測らない）
//   2. 同時 100 接続で `GET /api/v1/agents` を一定時間叩く
//   3. エラー率 = (2xx 以外 ＋ 接続エラー ＋ タイムアウト) / 総リクエスト数
//
// **叩く先に `GET /api/v1/agents` を選んだ理由.** 認証（トークンのハッシュ照合 ＋ DB の引き当て）と
// テナント境界つきの一覧クエリを通る「ふつうの読み取り」で、**レート制限が掛かっていない**経路。
// レート制限のあるルート（中継・評価・明示実行・連鎖の検証）を選ぶと、同時 100 で 429 が返るのが
// 正しい挙動なので「エラー率 < 1%」を測れない（枠を環境変数で広げると、今度は本番と違う設定を
// 測ることになる）。上流 LLM を呼ぶ経路も選ばない（実キーと課金が要る）。
//
// **2xx 以外だけを数えない.** 応答が返らなかった要求は `non2xx` に現れないので、それだけを見ると
// 「接続を切られた分」が無かったことになる。**ただし `errors` と `timeouts` を足し合わせない** —
// autocannon の `errors` は**タイムアウトを含む**（`lib/run.js` の `onTimeout()` が
// `errors++; timeouts++` の両方を数え、README も「including timeouts」と書いている）。
// 足すとタイムアウトを二重に数え、**基準を満たしている計測を赤にする**（2 万件中 100 件の
// タイムアウトは本当は 0.5% だが 1.0% として出る）。`timeouts` は内訳として別に出すだけにする。
import 'dotenv/config';
import autocannon from 'autocannon';
import { requireContractDatabase } from './lib/contract-database.mjs';
import { intFromEnv, runBench } from './lib/bench-criteria.mjs';
import {
  CONCURRENCY_CONNECTIONS,
  CONCURRENCY_DURATION_SECONDS,
  CONCURRENCY_MAX_ERROR_PERCENT,
} from './lib/step7-criteria.mjs';
import { freePort, runDemoFlow, startDemoApp } from './lib/demo-flow.mjs';
import { createPrismaClient } from '../src/lib/prisma-client';
import { issueSecret } from '../src/lib/tokens';

// 同時に張る接続の数。**既定は受け入れ基準の値**（環境変数で下げたら判定が落とす）
const CONNECTIONS = intFromEnv('BENCH_CONCURRENCY_CONNECTIONS', CONCURRENCY_CONNECTIONS, 1);
// 負荷を掛ける秒数（既定は受け入れ基準の正本から。短くすると最小件数の門番が落とす）
const DURATION_SECONDS = intFromEnv('BENCH_CONCURRENCY_DURATION', CONCURRENCY_DURATION_SECONDS, 1);
// 百分率へ直すための係数（裸の 100 を式に書かない）
const PERCENT_SCALE = 100;
// エラー率を残す小数の桁（10^4 = 小数第 4 位まで）。**丸めすぎない** —
// 1 万件規模で 1 件の失敗（0.01%）を 0% に丸めると、失敗が無かったのと区別できなくなる
const PERCENT_ROUNDING = 10_000;

// 全テーブルを空にして「何も無い配備」を作る
async function resetDatabase(): Promise<void> {
  // 本番と同じ結線
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
  // プラットフォーム管理者トークン（仕込みの入口。使い捨てをここで作る）
  const platformAdminToken = issueSecret('user').secret;
  // 監査ログの HMAC 鍵（仕込みのデモの筋が停止を 1 回行うので要る。同じく使い捨て）
  const auditSecret = issueSecret('user').secret;
  // アプリが待ち受けるポート
  const port = await freePort();
  // 起動した子プロセス（後始末で止める）
  let app: Awaited<ReturnType<typeof startDemoApp>> | undefined;
  try {
    // 本番ビルドを起こす
    app = await startDemoApp({ port, platformAdminToken, auditSecret });
    // デモの筋を 1 回通して、叩く相手（テナント・エージェント）とトークンを用意する
    const flow = await runDemoFlow({ baseUrl: `http://127.0.0.1:${port}`, platformAdminToken });
    // 同時 100 接続で一覧を叩く
    const result = await autocannon({
      url: `http://127.0.0.1:${port}/api/v1/agents`,
      connections: CONNECTIONS,
      duration: DURATION_SECONDS,
      method: 'GET',
      headers: { authorization: `Bearer ${flow.token}` },
    });
    // 失敗として数えるもの（2xx 以外 ＋ 応答が返らなかった要求）。
    // **`timeouts` を足さない** — `errors` が既に含んでいる（上のコメント）
    const errorRequests = result.non2xx + result.errors;
    // 総リクエスト数（分母。0 件のときは下の最小件数の門番が落とす）。
    // **`requests.total` ではなく `requests.sent` を使う** — 前者は `totalCompletedRequests`
    // （＝応答を受け取った件数）で、接続エラーとタイムアウトを含まない。一方で分子はそれらを
    // 含むので、`total` を分母にすると**単位が揃わず 100% を超えうる**（2,000 件送って
    // 1,200 件がタイムアウト・800 件が 200 なら、本当は 60% なのに 1200/800 = 150% と出る）。
    // `sent` は `client.on('request')` の累計＝送った件数で、分子と同じ母集団を指す
    // （`node_modules/autocannon/lib/aggregateResult.js` の `result.requests.sent =
    // aggregated.totalRequests` と `lib/run.js:216` で確認）
    const requests = result.requests.sent;
    // エラー率（%）。要求が 1 件も流れなかったときは 100% として扱う（最小件数の門番も落とす）
    const errorPercent =
      requests === 0
        ? PERCENT_SCALE
        : Math.round((errorRequests / requests) * PERCENT_SCALE * PERCENT_ROUNDING) /
          PERCENT_ROUNDING;
    // 計測結果（受け入れ基準も門番も runBench がこの項目を読んで掛ける）
    return {
      connections: CONNECTIONS,
      durationSeconds: DURATION_SECONDS,
      requests,
      errorRequests,
      errorPercent,
      limitErrorPercent: CONCURRENCY_MAX_ERROR_PERCENT,
      // 内訳（判定には使わないが、何が起きたか読めるように残す）。
      // `timeouts` は `connectionErrors` の**内数**（autocannon の数え方。上のコメント）
      non2xx: result.non2xx,
      connectionErrors: result.errors,
      timeouts: result.timeouts,
      // 応答を受け取った件数（分母の `requests` は送った件数なので、差は打ち切り時の飛行中の分）
      completedRequests: result.requests.total,
      // 遅延の裾（同じく参考値。同時実行では待ち行列が伸びるので判定には使わない）
      latencyP97_5Ms: result.latency.p97_5,
      latencyMaxMs: result.latency.max,
    };
  } finally {
    // アプリを止める（計測の成否に関わらず必ず）
    app?.kill('SIGKILL');
  }
}

// **接続先が専用 DB かをここで確かめる**（開発 DB を TRUNCATE しない）
requireContractDatabase('bench:concurrency');

// 計測 → 判定 → 出力 → 終了コードを共有モジュールに任せて実行する
runBench('concurrency-error-rate', main);
