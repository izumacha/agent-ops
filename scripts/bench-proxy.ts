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
import { contractDatabaseProblem } from './lib/contract-database.mjs';
import { PROXY_ADDED_LATENCY_P95_MAX_MS } from './lib/step2-criteria.mjs';
import { createPrismaClient } from '../src/lib/prisma-client';
import { displayPrefix, hashSecret, issueSecret } from '../src/lib/tokens';
import { Plan, Provider } from '../src/domain/types';

// 負荷を掛ける秒数 (1 本あたり)
const DURATION_SECONDS = Number(process.env.BENCH_DURATION ?? '10');
// **同時接続は 1 本にして逐次で測る。** 受け入れ基準が見たいのは「中継したぶん 1 件あたり
// 何ミリ秒増えるか」で、待ち行列の長さではない。実測で 3 通り試した結果がこの選択の理由:
//   - 10 接続・無制限: 追加 72ms。autocannon は常に 10 件を飛ばし続けるので必ず飽和し、
//     測れるのは 1 プロセスの処理能力 (この機械では約 130 req/s) になる
//   - 10 接続・毎秒 50 件に制限: 追加 166ms。上流を直接叩く側ですら 34ms になり、
//     autocannon 自身のペース配分 (1 秒ごとにまとめて発射する) の待ち時間が混ざる
//   - 1 接続・無制限 (これ): 追加 11ms。待ち行列もペース配分も無いので、増えた時間だけが出る
// 同時実行時の振る舞いは Step7 の負荷試験 (同時 100 リクエストでエラー率 < 1%) が見る
const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS ?? '1');
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

// 1 本の計測 (autocannon) を回して上位 percentile の遅延を返す
async function measureLatency(options: {
  url: string;
  headers: Record<string, string>;
}): Promise<{ latencyMs: number; non2xx: number; requests: number }> {
  // 負荷を掛ける
  const result = await autocannon({
    url: options.url,
    connections: CONNECTIONS,
    duration: DURATION_SECONDS,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...options.headers },
    body: REQUEST_BODY,
    // スタブは自己署名証明書なので、計測側は検証しない (信頼の判断はアプリ側で行っている)
    tlsOptions: { rejectUnauthorized: false },
  });
  // p97.5 (ミリ秒)・2xx 以外の件数・総リクエスト数
  return {
    latencyMs: result.latency.p97_5,
    non2xx: result.non2xx + result.errors + result.timeouts,
    requests: result.requests.total,
  };
}

// ベンチ本体
async function main(): Promise<void> {
  // 接続先が専用 DB か (開発 DB を TRUNCATE しない)
  const problem = contractDatabaseProblem(process.env.DATABASE_URL);
  if (problem !== null) {
    throw new Error(`bench:proxy は専用 DB でだけ実行してください: ${problem}`);
  }
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
        directMs: direct.latencyMs,
        proxiedMs: proxied.latencyMs,
        addedMs,
        limitMs: PROXY_ADDED_LATENCY_P95_MAX_MS,
        requests: { direct: direct.requests, proxied: proxied.requests },
        passed: addedMs <= PROXY_ADDED_LATENCY_P95_MAX_MS,
      }),
    );
    // 基準を超えていれば失敗
    if (addedMs > PROXY_ADDED_LATENCY_P95_MAX_MS) {
      throw new Error(
        `追加遅延が大きすぎます: ${addedMs}ms (上限 ${PROXY_ADDED_LATENCY_P95_MAX_MS}ms)`,
      );
    }
  } finally {
    // アプリとスタブを止め、一時ファイルを消す (§8 リソースを確実に解放する)
    app?.kill('SIGKILL');
    stub?.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

// 実行する (失敗は非 0 終了にする)
main().catch((error: unknown) => {
  // 理由を出して落ちる
  console.error('[bench:proxy]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
