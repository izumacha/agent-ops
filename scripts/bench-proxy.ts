// Step2 の受け入れ基準「プロキシ経由の追加遅延 p95 ≦ 50ms（autocannon）」を実測するベンチ。
//   DATABASE_URL='postgresql://…/agent_ops_contract?schema=app' npm run build && npm run bench:proxy
//
// 測り方 (「追加遅延」の定義はこのファイルが唯一の場所):
//   1. ローカルのスタブ上流 (https) を立てる。**実際の Anthropic / OpenAI は呼ばない** (課金も API キーも不要)
//   2. autocannon でスタブを直接叩く          → 上位percentile(直接)
//   3. 同じ本文をプロキシ経由で叩く            → 上位percentile(プロキシ)
//   4. 追加遅延 = プロキシ − 直接
//
// **測る percentile は 97.5%**。受け入れ基準は p95 だが、autocannon (hdr-histogram-percentiles-obj) が
// 出す percentile は p90 / p97_5 / p99 … で p95 が無い。p97.5 は p95 より**厳しい側**なので、
// ここで基準を満たせば p95 でも満たす (緩い側の p90 で代用すると基準を満たさない実装が通ってしまう)
//
// スタブを **https** にしているのは、本番と同じ経路を測るため。プロキシの接続先の判定は
// 「https、または非本番のループバック http」なので、http のスタブを本番ビルドのアプリに向けると
// (正しく) 503 になる。自己署名証明書を作り、アプリには NODE_EXTRA_CA_CERTS で信頼させる
import 'dotenv/config';
import autocannon from 'autocannon';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireContractDatabase } from './lib/contract-database.mjs';
import { PROXY_ADDED_LATENCY_P95_MAX_MS } from './lib/step2-criteria.mjs';
import {
  WARMUP_MAX_MS,
  intFromEnvValue,
  requireAddedLatencyWithinLimit,
  warmupCountProblem,
  warmupLatencyProblem,
} from './lib/bench-criteria.mjs';
import { createPrismaClient } from '../src/lib/prisma-client';
import { displayPrefix, hashSecret, issueSecret } from '../src/lib/tokens';
import { Plan, Provider } from '../src/domain/types';

// 環境変数を 0 以上の整数として読む (判定は scripts/lib/bench-criteria.mjs が持つ)
function intFromEnv(name: string, fallback: number, minimum: number): number {
  // 生の値を渡して判定させる (読めなければ例外)
  return intFromEnvValue(name, process.env[name], fallback, minimum);
}

// 負荷を掛ける秒数 (1 本あたり)
const DURATION_SECONDS = intFromEnv('BENCH_DURATION', 10, 1);
// **同時接続は 1 本にして逐次で測る。** 受け入れ基準が見たいのは「中継したぶん 1 件あたり
// 何ミリ秒増えるか」で、待ち行列の長さではない。実測で 3 通り試した結果がこの選択の理由:
//   - 10 接続・無制限: 追加 72ms。autocannon は常に 10 件を飛ばし続けるので必ず飽和し、
//     測れるのは 1 プロセスの処理能力 (この機械では約 130 req/s) になる
//   - 10 接続・毎秒 50 件に制限: 追加 166ms。上流を直接叩く側ですら 34ms になり、
//     autocannon 自身のペース配分 (1 秒ごとにまとめて発射する) の待ち時間が混ざる
//   - 1 接続・無制限 (これ): 追加 11ms。待ち行列もペース配分も無いので、増えた時間だけが出る
// 同時実行時の振る舞いは Step7 の負荷試験 (同時 100 リクエストでエラー率 < 1%) が見る
const CONNECTIONS = intFromEnv('BENCH_CONNECTIONS', 1, 1);
// 計測の前に捨てて回す**件数** (**判定には使わない**。理由は下の measureLatency のコメント)。
// 秒ではなく件数で決めるのは、吸収したい初回コストが「最初の数十件」という**件数の現象**だから。
// 秒で決めると遅い機械ほど捨てられる件数が減り、いちばん必要な場所で効かなくなる
const WARMUP_REQUESTS = intFromEnv('BENCH_WARMUP', 200, 0);
// 計測として成立する最小の件数 (これを下回る = ほとんど流せていないので判定しない)
const MIN_REQUESTS = 100;
// 中継するモデル (料金表にある値)
const MODEL = 'claude-sonnet-4-6';
// アプリの起動を待つ上限 (ミリ秒)
const STARTUP_TIMEOUT_MS = 30_000;
// 起動待ちの確認間隔 (ミリ秒)
const STARTUP_POLL_MS = 200;
// 本番ビルドの成果物 (standalone 出力)
const STANDALONE_SERVER = join(process.cwd(), '.next', 'standalone', 'server.js');

// スタブ上流が返す本文 (usage を持つ Anthropic 形式)
const UPSTREAM_BODY = JSON.stringify({
  id: 'msg_bench',
  content: [{ type: 'text', text: 'ok' }],
  usage: { input_tokens: 100, output_tokens: 50 },
});
// 中継に送る本文
const REQUEST_BODY = JSON.stringify({
  model: MODEL,
  messages: [{ role: 'user', content: 'ping' }],
});

// 空いている TCP ポートを 1 つ取る (固定ポートだと CI で衝突する)
async function freePort(): Promise<number> {
  // 一時的に 0 番で待ち受けて、割り当てられたポートを読む
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      // 割り当てられたポート
      const address = server.address();
      // アドレスが読めなければ失敗
      if (address === null || typeof address === 'string') {
        reject(new Error('ポートを取得できません'));
        return;
      }
      // 閉じてから返す
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

// 自己署名証明書を作る (ローカルのスタブ上流を https にするため)
function createSelfSignedCert(dir: string): { key: string; cert: string } {
  // 鍵と証明書の出力先
  const keyPath = join(dir, 'stub-key.pem');
  const certPath = join(dir, 'stub-cert.pem');
  // openssl で 1 枚作る (SAN に 127.0.0.1 を入れる。入れないと Node が証明書を拒否する)
  const result = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-keyout',
      keyPath,
      '-out',
      certPath,
    ],
    { encoding: 'utf8' },
  );
  // 失敗したら理由を出して落ちる (openssl が無い環境ではベンチを回せない)
  if (result.status !== 0) {
    throw new Error(`自己署名証明書を作れません (openssl): ${result.stderr}`);
  }
  // 読み込んで返す
  return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') };
}

// スタブ上流を起動する (固定の JSON を返すだけ)
async function startStubUpstream(port: number, dir: string): Promise<Server> {
  // 証明書
  const credentials = createSelfSignedCert(dir);
  // 受け取った本文を読み捨ててから応答する (本文を読まないと接続が滞留する)
  const server = createHttpsServer(credentials, (request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(UPSTREAM_BODY);
    });
  });
  // 待ち受け開始
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}

// 計測用のテナント・エージェント・API キーを用意する (平文のキーを返す)
async function seedApiKey(): Promise<string> {
  // 本番と同じ結線
  const client = createPrismaClient();
  // 後始末のために try で囲む
  try {
    // 全テーブルを空にする (専用 DB であることは呼び出し前に確かめている)
    await client.$executeRaw`TRUNCATE TABLE "Tenant" CASCADE`;
    // テナント
    const tenant = await client.tenant.create({ data: { name: 'ベンチ', plan: Plan.free } });
    // エージェント
    const agent = await client.agent.create({
      data: { tenantId: tenant.id, name: 'ベンチ用', provider: Provider.anthropic, model: MODEL },
    });
    // API キー (平文は発行時しか手に入らない)
    const secret = issueSecret('apiKey');
    await client.apiKey.create({
      data: {
        tenantId: tenant.id,
        agentId: agent.id,
        prefix: displayPrefix(secret.secret),
        keyHash: hashSecret(secret.secret),
        name: 'ベンチ用キー',
      },
    });
    // 平文を返す
    return secret.secret;
  } finally {
    // 接続を閉じる
    await client.$disconnect();
  }
}

// アプリ (本番ビルド) を起動して、応答するようになるまで待つ
async function startApp(port: number, upstreamPort: number, caPath: string): Promise<ChildProcess> {
  // 本番ビルドが無ければ測れない
  if (!existsSync(STANDALONE_SERVER)) {
    throw new Error(`本番ビルドがありません: 先に npm run build を実行してください`);
  }
  // 子プロセスとして起動する
  const app = spawn(process.execPath, [STANDALONE_SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      // 上流はローカルのスタブ (https)
      ANTHROPIC_BASE_URL: `https://127.0.0.1:${upstreamPort}`,
      ANTHROPIC_API_KEY: 'bench-upstream-key',
      // スタブの自己署名証明書を信頼させる (この 1 枚だけ)
      NODE_EXTRA_CA_CERTS: caPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // 起動の失敗を拾えるよう、出力はためておく
  let output = '';
  app.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  app.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  // 健康確認が通るまで待つ
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  for (;;) {
    // 期限切れなら落ちる
    if (Date.now() > deadline) {
      app.kill('SIGKILL');
      throw new Error(`アプリが起動しませんでした:\n${output}`);
    }
    // health を叩いてみる
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (response.ok) return app;
    } catch {
      // まだ起動していないだけなので待つ
    }
    // 少し待って再試行する
    await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_MS));
  }
}

// 1 回ぶんの負荷を掛けて、遅延の分布をそのまま返す (判定に使う値は呼び出し側が選ぶ)
async function runLoad(
  options: { url: string; headers: Record<string, string> } & (
    | // 秒で回す (本計測)
      { durationSeconds: number; amount?: never }
      // 件数で回す (捨て玉)
    | { amount: number; durationSeconds?: never }
  ),
): Promise<{
  p97_5Ms: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  non2xx: number;
  requests: number;
}> {
  // 負荷を掛ける
  const result = await autocannon({
    url: options.url,
    connections: CONNECTIONS,
    // amount を渡した回は「その件数を流し終えたら止まる」(autocannon は duration より amount を優先する)
    ...(options.amount === undefined
      ? { duration: options.durationSeconds }
      : { amount: options.amount }),
    method: 'POST',
    headers: { 'content-type': 'application/json', ...options.headers },
    body: REQUEST_BODY,
    // スタブは自己署名証明書なので、計測側は検証しない (信頼の判断はアプリ側で行っている)
    tlsOptions: { rejectUnauthorized: false },
  });
  // 分布と、2xx 以外の件数・総リクエスト数
  return {
    p97_5Ms: result.latency.p97_5,
    p50Ms: result.latency.p50,
    p99Ms: result.latency.p99,
    maxMs: result.latency.max,
    non2xx: result.non2xx + result.errors + result.timeouts,
    requests: result.requests.total,
  };
}

// 1 本の計測。**先に捨て玉 (ウォームアップ) を流してから測る。**
//
// なぜ要るか: 起動直後の十数件だけが桁違いに遅い (Next.js のルート読み込み・Prisma の接続確立・
// 上流への TLS 確立・JIT)。これは「中継 1 件あたり何ミリ秒増えるか」ではなく**初回コスト**なので、
// 定常状態を見る受け入れ基準の判定へ混ぜない。
//
// **混ざると判定が機械の速さで割れる。** 遅い機械ほど 10 秒間に流せる件数が減り、同じ初回コストが
// 上位 percentile を押し上げる。実測 (どちらも同じコミット・捨て玉なし):
//   - この開発機 (2 コアに固定): proxied 1358 件・p50 6ms・p99 16ms・**max 113ms** → p97.5 12ms で合格
//   - CI ランナー (2 vCPU・Postgres 同居): proxied 606 件・平均 16.5ms・**p97.5 155ms** → 不合格。
//     606 件の 2.5% は 15 件しかないので、初回の十数件だけで p97.5 が決まってしまう
// 捨て玉を入れた同じ機械での実測: 捨て玉側の max 109ms に対し、本計測は max 113→35ms・p99 16→12ms。
// **外れ値が捨て玉の窓に移った**ことが、これが初回コストである (再発する GC 等ではない) 証拠
//
// **基準は緩めていない** — 上限 50ms・percentile・追加遅延の定義 (プロキシ − 直接) はそのまま。
// 捨てた側も黙らせず JSON に出すので、初回コストが悪化したときは結果を読めば分かる
async function measureLatency(options: { url: string; headers: Record<string, string> }): Promise<{
  latencyMs: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  non2xx: number;
  requests: number;
  warmup: { maxMs: number; requests: number } | null;
}> {
  // 捨て玉 (0 件を指定したときは流さない。**捨て玉なしでも測れる**ことを残しておく)
  const warmup =
    WARMUP_REQUESTS > 0 ? await runLoad({ ...options, amount: WARMUP_REQUESTS }) : null;
  // 本計測 (窓の長さは捨て玉に関わらず一定)
  const measured = await runLoad({ ...options, durationSeconds: DURATION_SECONDS });
  // 捨て玉そのものを 2 つの観点で確かめる (捨て玉を切っているときは対象が無いので飛ばす):
  //   1. 指定どおりの件数で止まったか。autocannon が `amount` より `duration` を優先する版へ
  //      変わると捨て玉が秒で回って初回コストを吸収しきれなくなるが、**判定結果には現れない**
  //      (本計測はそのまま緑になる) ので、ここで落とす (fail-closed)
  //   2. 初回コストそのものが桁で悪化していないか。**捕まえるのは桁の悪化だけ** —
  //      起動直後に +150ms 増える程度 (実測で捨て玉の最大が 127→266ms) はこの上限では落ちない。
  //      意図的にそうしてある: ここを判定 (50ms) へ近づけると、初回コストを判定から外すという
  //      捨て玉の目的と衝突する。値と根拠は scripts/lib/bench-criteria.mjs の WARMUP_MAX_MS
  if (warmup !== null) {
    // 先に見つかった理由だけを出す
    const problem =
      warmupCountProblem(WARMUP_REQUESTS, warmup.requests) ??
      warmupLatencyProblem(warmup.maxMs, WARMUP_MAX_MS);
    // どちらかに引っ掛かれば、その理由で落とす
    if (problem !== null) throw new Error(problem);
  }
  // 捨て玉で失敗していたら本計測の数字も信用できない (認証の取り違え等) ので、件数を合算して返す。
  // **この合算は load-bearing** — 外すと「捨て玉の窓だけ 401 になる」設定ミスが丸ごと消える
  // (実測: 外した版は全件 2xx 扱いで `passed: true` を返した)
  return {
    latencyMs: measured.p97_5Ms,
    p50Ms: measured.p50Ms,
    p99Ms: measured.p99Ms,
    maxMs: measured.maxMs,
    non2xx: measured.non2xx + (warmup?.non2xx ?? 0),
    requests: measured.requests,
    warmup: warmup === null ? null : { maxMs: warmup.maxMs, requests: warmup.requests },
  };
}

// 計測 1 本ぶんの分布を、結果の JSON へ載せる形へ整える (direct / proxied で同じ形にするため
// 1 か所にまとめる。手書きで 2 つ並べると、片方にだけ項目を足す差分が書ける)
function distributionOf(measured: {
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  warmup: { maxMs: number; requests: number } | null;
}): Record<string, unknown> {
  // 判定には使わないが、初回コストや裾の伸びを読めるようにする値
  return { p50: measured.p50Ms, p99: measured.p99Ms, max: measured.maxMs, warmup: measured.warmup };
}

// ベンチ本体
async function main(): Promise<void> {
  // 証明書や一時ファイルの置き場
  const workDir = mkdtempSync(join(tmpdir(), 'agent-ops-bench-'));
  // 起動したもの (後始末で止める)
  let stub: Server | undefined;
  let app: ChildProcess | undefined;
  try {
    // ポートを 2 つ取る
    const upstreamPort = await freePort();
    const appPort = await freePort();
    // スタブ上流を起動する
    stub = await startStubUpstream(upstreamPort, workDir);
    // 計測用の API キーを用意する
    const apiKey = await seedApiKey();
    // アプリを起動する
    app = await startApp(appPort, upstreamPort, join(workDir, 'stub-cert.pem'));
    // 1) 上流を直接叩いたときの遅延
    const direct = await measureLatency({
      url: `https://127.0.0.1:${upstreamPort}/v1/messages`,
      headers: {},
    });
    // 2) プロキシ経由の遅延
    const proxied = await measureLatency({
      url: `http://127.0.0.1:${appPort}/api/v1/proxy/anthropic/messages`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    // 失敗した要求があると遅延が実力より良く出るので、そのまま通さない
    if (direct.non2xx > 0 || proxied.non2xx > 0) {
      throw new Error(
        `2xx 以外の応答がありました (直接: ${direct.non2xx} 件 / プロキシ: ${proxied.non2xx} 件)`,
      );
    }
    // 件数が少なすぎる計測は判定に使わない (1 件だけ成功して p97.5 が 0ms、のような結果を通さない)
    for (const [label, measured] of [
      ['直接', direct],
      ['プロキシ', proxied],
    ] as const) {
      // 最低限の件数が無ければ測定として成立しない
      if (measured.requests < MIN_REQUESTS) {
        throw new Error(
          `${label}の計測が ${measured.requests} 件しか流せていません (最低 ${MIN_REQUESTS} 件)`,
        );
      }
    }
    // 追加遅延 (この定義がこのファイルの要点)
    const addedMs = Math.round((proxied.latencyMs - direct.latencyMs) * 100) / 100;
    // 結果を出す
    console.log(
      JSON.stringify({
        bench: 'proxy-latency',
        connections: CONNECTIONS,
        durationSeconds: DURATION_SECONDS,
        percentile: 'p97.5 (p95 は autocannon が出さないため、より厳しい側で測る)',
        warmupRequests: WARMUP_REQUESTS,
        directMs: direct.latencyMs,
        proxiedMs: proxied.latencyMs,
        addedMs,
        limitMs: PROXY_ADDED_LATENCY_P95_MAX_MS,
        requests: { direct: direct.requests, proxied: proxied.requests },
        // 判定には使わないが、初回コストや裾の伸びを読めるように残す (上の measureLatency のコメント)
        distribution: { direct: distributionOf(direct), proxied: distributionOf(proxied) },
        passed: addedMs <= PROXY_ADDED_LATENCY_P95_MAX_MS,
      }),
    );
    // 基準を超えていれば失敗 (判定は scripts/lib/bench-criteria.mjs が持つ)
    requireAddedLatencyWithinLimit(addedMs, PROXY_ADDED_LATENCY_P95_MAX_MS);
  } finally {
    // アプリとスタブを止め、一時ファイルを消す (§8 リソースを確実に解放する)
    app?.kill('SIGKILL');
    stub?.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

// **接続先が専用 DB かをここで確かめる** (開発 DB を TRUNCATE しない)。
// 判定と throw をまとめた関数を**トップレベルの式文として**呼ぶ — main の中で
// `const problem = …; if (problem !== null && 何か) throw` と書けると、条件を 1 つ足すだけで
// ガードが実質外れる (実測で 705 件すべて緑だった)。この形なら外すには呼び出しごと消すしかない
requireContractDatabase('bench:proxy');

// 実行する (失敗は非 0 終了にする)
main().catch((error: unknown) => {
  // 理由を出して落ちる
  console.error('[bench:proxy]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
