// 保守の定期実行のティック（scripts/maintenance-tick.mjs）の検査。
//
// **スクリプトを実際に起動して確かめる。** 中身を真似た写しをテストに書くと、写しが緑になる
// だけで本体の退行を拾えない。叩く先はこのテストが立てるスタブの HTTP サーバーで、
// アプリも DB も起こさない。
//
// ここで固定するのは 4 つ:
//   1. **`passComplete` が真になるまで繰り返す**（1 回で止めると掃きが途中で終わる）
//   2. **返ったカーソルをそのまま送り返す**（送らないと同じ先頭を何度も叩き続ける）
//   3. **判定の取りこぼし（`failed > 0`）で非 0 終了**（アプリ側は 200 を返すので、
//      運用者が気付ける唯一の出口がこの終了コード）
//   4. **設定不足・HTTP エラーで非 0 終了**（「設定が無いから成功」に倒さない）
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

// スクリプトの場所（リポジトリ直下から見た相対）
const SCRIPT = join(process.cwd(), 'scripts', 'maintenance-tick.mjs');
// トークン（スタブは中身を見ないが、未設定だと叩く前に落ちるので値を渡す）
const TOKEN = 'maintenance-tick-test-token-0123456789';

// 立てたサーバー（各テストの後で閉じる）
let server: Server | undefined;

/** 受け取った本文の列（カーソルを送り返しているかを見る） */
interface Received {
  bodies: Record<string, unknown>[];
}

/**
 * 応答を順に返すスタブを立てる。
 * @param responses 1 要求ごとに返す本文（足りなくなったら最後のものを返し続ける）
 * @param status 返すステータス（既定 200）
 * @returns 入口の URL と、受け取った本文の記録
 */
async function startStub(
  responses: Record<string, unknown>[],
  status = 200,
): Promise<{ baseUrl: string; received: Received }> {
  // 受け取った本文を控える
  const received: Received = { bodies: [] };
  // 何回目の要求かを数える
  let call = 0;
  // 要求ごとに本文を読んで応答を返す
  server = createServer((request, response) => {
    // 本文を集める
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      // 控える（JSON として読めなければ空として扱う）
      const text = Buffer.concat(chunks).toString('utf8');
      received.bodies.push(text === '' ? {} : (JSON.parse(text) as Record<string, unknown>));
      // その回の応答（足りなければ最後のもの）
      const body = responses[Math.min(call, responses.length - 1)];
      call += 1;
      // 返す
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
  });
  // 空きポートで待ち受ける
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  // 実際のポートを読む
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('ポートを取れません');
  return { baseUrl: `http://127.0.0.1:${address.port}`, received };
}

/** 1 要求ぶんの応答を組み立てる（既定は「やることが残っていない」） */
function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rateLimitHitsDeleted: 0,
    rateLimitSweepComplete: true,
    agentsEvaluated: 0,
    rulesEvaluated: 0,
    fired: 0,
    failed: 0,
    passComplete: true,
    nextTenantCursor: null,
    nextAgentCursor: null,
    ...overrides,
  };
}

/**
 * スクリプトを起動して終わるまで待つ。
 *
 * **同期で待つ形（`spawnSync`）では書けない。** スタブの HTTP サーバーはこのテストと同じ
 * プロセスで動くので、同期で待つと**イベントループが止まって応答を返せず、子プロセスが
 * 永久に待つ**（実測でテストファイルの読み込みから先へ進まなくなった）。非同期で起こし、
 * 待っているあいだにサーバーが応答する形にする。
 * @param env 渡す環境変数（`PATH` 等は引き継ぐ）
 * @returns 終了コードと標準出力・標準エラー
 */
async function runTick(env: Record<string, string | undefined>): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  // 子プロセスとして起こす（本体をそのまま走らせる）
  const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, ...env } });
  // 出力を集める（読み捨てないと標準出力が詰まって子が止まりうる）
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  // 終わるまで待つ
  const status = await new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code));
  });
  return { status, stdout, stderr };
}

describe('保守の定期実行のティック', () => {
  afterEach(async () => {
    // 立てたサーバーを閉じる
    if (server !== undefined) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  });

  it('passComplete が真になるまで繰り返し、カーソルを送り返す', async () => {
    // 3 回で終わる応答列（1 回目はテナントとエージェントの続き、2 回目はテナントだけ）
    const { baseUrl, received } = await startStub([
      result({ passComplete: false, nextTenantCursor: 'T1', nextAgentCursor: 'A1' }),
      result({ passComplete: false, nextTenantCursor: 'T2', nextAgentCursor: null }),
      result({ agentsEvaluated: 3 }),
    ]);
    // 起動する
    const tick = await runTick({ MAINTENANCE_BASE_URL: baseUrl, PLATFORM_ADMIN_TOKEN: TOKEN });
    // 一巡を回し切って 0 で終わる
    expect(tick.status, tick.stderr).toBe(0);
    // **3 回叩いている**（1 回で止める変異はここで落ちる）
    expect(received.bodies.length).toBe(3);
    // 1 回目は一巡の開始なのでカーソルを送らない
    expect(received.bodies[0]).toEqual({});
    // 2 回目は 1 回目のカーソルをそのまま送る
    expect(received.bodies[1]).toEqual({ tenantCursor: 'T1', agentCursor: 'A1' });
    // 3 回目は `null` のカーソルを送らない（そこは先頭から）
    expect(received.bodies[2]).toEqual({ tenantCursor: 'T2' });
    // 合計が 1 行 1 JSON で出る
    expect(JSON.parse(tick.stdout.trim())).toMatchObject({
      event: 'maintenance.tick',
      requests: 3,
      agentsEvaluated: 3,
    });
  });

  it('回収が途中のときは同じ呼び方をもう一度する（カーソルが両方 null）', async () => {
    // 1 回目は「回収が途中」、2 回目で終わる
    const { baseUrl, received } = await startStub([
      result({
        passComplete: false,
        rateLimitSweepComplete: false,
        rateLimitHitsDeleted: 10,
        nextTenantCursor: null,
        nextAgentCursor: null,
      }),
      result({ rateLimitHitsDeleted: 5 }),
    ]);
    const tick = await runTick({ MAINTENANCE_BASE_URL: baseUrl, PLATFORM_ADMIN_TOKEN: TOKEN });
    expect(tick.status, tick.stderr).toBe(0);
    // 2 回叩き、どちらもカーソル無し
    expect(received.bodies).toEqual([{}, {}]);
    // 消した件数は足し合わせる
    expect(JSON.parse(tick.stdout.trim())).toMatchObject({ rateLimitHitsDeleted: 15 });
  });

  it('判定の取りこぼしがあれば非 0 で終わる（アプリは 200 を返すので唯一の出口）', async () => {
    // 一巡は終わるが 2 件取りこぼしている
    const { baseUrl } = await startStub([result({ failed: 2 })]);
    const tick = await runTick({ MAINTENANCE_BASE_URL: baseUrl, PLATFORM_ADMIN_TOKEN: TOKEN });
    // 非 0 で、理由が標準エラーに出る
    expect(tick.status).not.toBe(0);
    expect(tick.stderr).toContain('2');
    // 合計は標準出力に出ている（失敗しても記録は残す）
    expect(JSON.parse(tick.stdout.trim())).toMatchObject({ failed: 2 });
  });

  it('2xx 以外が返れば非 0 で終わる（状態が分からないまま叩き続けない）', async () => {
    // 403 を返すスタブ
    const { baseUrl, received } = await startStub([{ message: 'forbidden' }], 403);
    const tick = await runTick({ MAINTENANCE_BASE_URL: baseUrl, PLATFORM_ADMIN_TOKEN: TOKEN });
    expect(tick.status).not.toBe(0);
    expect(tick.stderr).toContain('403');
    // 1 回で止まっている
    expect(received.bodies.length).toBe(1);
  });

  it('設定が足りなければ叩かずに非 0 で終わる（fail-closed）', async () => {
    // **実在するスタブを入口にする。** 到達しない入口（閉じたポート）を指すと、
    // ガードが無くても `fetch` の失敗で非 0 になるので**ガードの有無で結果が変わらない**
    // （実測で、トークンの検査を外す変異が 6 件すべて緑のまま通った）。生きた入口を指し、
    // **要求が 1 件も届いていないこと**まで見ると「叩かずに」が実際に固定される
    const { baseUrl, received } = await startStub([result()]);
    // 入口が無い
    const noUrl = await runTick({ MAINTENANCE_BASE_URL: '', PLATFORM_ADMIN_TOKEN: TOKEN });
    expect(noUrl.status).not.toBe(0);
    // トークンが無い（入口は生きているので、叩けば必ず記録に残る）
    const noToken = await runTick({ MAINTENANCE_BASE_URL: baseUrl, PLATFORM_ADMIN_TOKEN: '' });
    expect(noToken.status).not.toBe(0);
    // **1 件も叩いていない**
    expect(received.bodies.length, '設定不足なのに要求を送っている').toBe(0);
  });

  it('予算の指定があれば本文に載せる', async () => {
    const { baseUrl, received } = await startStub([result()]);
    const tick = await runTick({
      MAINTENANCE_BASE_URL: baseUrl,
      PLATFORM_ADMIN_TOKEN: TOKEN,
      MAINTENANCE_AGENT_BUDGET: '7',
    });
    expect(tick.status, tick.stderr).toBe(0);
    // **数値として**載る（文字列で送るとアプリ側が 422 にする）
    expect(received.bodies[0]).toEqual({ agentBudget: 7 });
  });
});
