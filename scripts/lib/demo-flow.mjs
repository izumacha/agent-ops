// Step7 の「デモ動作」の筋と、それを測るためのアプリ起動。**2 本のベンチが共有する** —
// `bench-demo-ready`（基準①の部分集合）と `bench-concurrency`（基準②の仕込み）が、どちらも
// 「本番ビルドを起こしてテナントを 1 つ作る」ところまで同じことをする
// （`freePort` だけは `bench-proxy` も使うので 3 本から参照される）。
//
// **HTTP だけでデモの筋を通す。** DB へ直接書いて仕込むと「配備した成果物で動くか」を測らない
// （CI の compose 経路ではコンテナの中へ入れない）。ブートストラップはプラットフォーム管理者の
// トークンで `POST /tenants` を叩く — これが**事業者もユーザーもまだ居ない状態からの唯一の入口**で、
// 応答に最初の admin のトークンが入っているので以後はそれで進められる。
//
// **import は許可リストの範囲だけ**（`node:child_process` / `node:fs` / `node:net` / `node:path`）。
// `process` は `env` / `cwd` / `execPath` の読み取りだけで、終了経路（`process.exit`）は 1 つも
// 持たない（`node:net` と `process.execPath` はこのモジュールのために許可リストへ足した。
// 理由は `tests/gate-scripts.test.ts` のそれぞれのコメント）。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer as createTcpServer } from 'node:net';
import { join } from 'node:path';

// 本番ビルド（standalone 出力）のエントリ
const STANDALONE_SERVER = join(process.cwd(), '.next', 'standalone', 'server.js');
// 起動を待つ上限（ミリ秒）。**基準の 5 分とは別** — こちらは「起動しなかった」を落とすための門番で、
// 基準の予算を使い切る前に原因の分かる失敗にする
const STARTUP_TIMEOUT_MS = 60_000;
// 起動確認の間隔（ミリ秒）
const STARTUP_POLL_MS = 100;
// 起動までの出力をためる上限（文字数）。原因が読める長さだけ残して、あとは捨てる
const STARTUP_OUTPUT_MAX_CHARS = 64 * 1024;
// 切り詰めたことを示す印（読む人が「出力がそこで終わった」と誤読しないように末尾へ付ける）
const STARTUP_OUTPUT_TRUNCATED_NOTE = '\n…(これ以降の出力は計測側が切り詰めました)';
// 起動確認の 1 回あたりの上限（ミリ秒）。待ち受けは始まったが応答を返さない状態で
// ループが止まらないようにする（上の `deadline` はこの中で進まないと評価されない）
const STARTUP_PROBE_TIMEOUT_MS = 5_000;
// デモの筋の 1 要求あたりの上限（ミリ秒）。**Node の global fetch は既定でタイムアウトしない**ので、
// 配備が応答を返さなくなる（DB のロック待ち・プーラの飽和など）と `runDemoFlow` が返らず、
// **基準の判定（所要時間と上限の比較）はその後ろにあるので一度も実行されない** —
// ジョブは「基準違反で赤」ではなく GitHub の上限まで無言でハングする。上限に当たれば
// `TimeoutError` が投げられ、ベンチは `runBench` 経由・プローブは catch 経由で
// 「どの段で止まったか」を添えて非 0 終了する
const REQUEST_TIMEOUT_MS = 30_000;
// OpenAPI の `servers.url` と同じ接頭辞
const API_PREFIX = '/api/v1';

/**
 * タイムアウト付きで叩く。**デモの筋のすべての要求がここを通る**（1 か所に集めるのは、
 * 新しい段を足した人が付け忘れても同じ上限が掛かるようにするため）。
 * @param {string} url 叩く先
 * @param {RequestInit} [init] fetch へ渡す設定（`signal` はここが決めるので渡さない）
 * @param {number} [timeoutMs] 上限（ミリ秒）
 * @returns {Promise<Response>} 応答
 */
function fetchWithTimeout(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  // 上限を過ぎたら中断する signal を付けて叩く
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * デモの筋（この順で通す）。**件数の正本はここ** — `step7-criteria.mjs` の
 * `DEMO_STEP_COUNT` と一致することはテストが固定する（写しを 2 つ持たない）。
 *
 * 選んだ理由: 「配備した直後の運用者が、何もない状態から**自分のテナントを立ち上げて
 * エージェントを登録し、上限を確認し、止めて、その操作が記録に残ったことを読める**」までが
 * 最小のデモ。**上流 LLM は呼ばない**（中継は実キーと課金が要るので、デモの筋には入れない）。
 *
 * **停止を入れているのは監査ログの段を意味のあるものにするため。** 記録を残す操作を 1 つも
 * しないまま `GET /audit-logs` を叩くと、空の一覧に 200 が返るだけで「運用の記録が残る配備
 * であること」を何も示さない（監査ログの書き込みが完全に壊れていても通る）。
 */
export const DEMO_STEPS = [
  'health',
  'create-tenant',
  'create-agent',
  'list-agents',
  'read-billing',
  'stop-agent',
  'read-audit-logs',
];

/**
 * 通った段のうち、**正本（`DEMO_STEPS`）と同じ名前が同じ位置にある**ものを数える。
 * 正本の隣に置くのは、突き合わせの規則を正本と一緒に読めるようにするため
 * （ベンチと CI のプローブが同じ数え方を使う。写しを 2 つ持たない）。
 * @param {readonly string[]} steps 実際に通った段の名前（順序どおり）
 * @returns {number} 正本と一致した位置の数
 */
export function countStepsInOrder(steps) {
  // 配列でなければ 0（判定が落ちる側へ倒す = fail-closed）
  if (!Array.isArray(steps)) return 0;
  // 同じ位置に同じ名前があるものを数える
  return steps.filter((step, at) => step === DEMO_STEPS[at]).length;
}

/**
 * 空いている TCP ポートを 1 つ取る（固定ポートだと CI で衝突する）。
 *
 * **3 本のベンチが共有する**（`bench-proxy` / `bench-demo-ready` / `bench-concurrency`）。
 * `bench-proxy.ts` は同じ処理を自前で持っていたが、Step7 でここへ寄せて写しを 1 本消した。
 * `e2e/lib/app.ts` の 1 本は残してある — あちらは静的アセットの配置・SIGTERM での停止・
 * ポートの掴み方が意図的に違う（同じ関数にすると片方の事情がもう片方を壊す）。
 * @returns {Promise<number>} 割り当てられたポート番号
 */
export async function freePort() {
  // 一時的に 0 番で待ち受けて、割り当てられたポートを読む
  return new Promise((resolve, reject) => {
    // 中身を持たないサーバーを 1 つ作る
    const server = createTcpServer();
    // 待ち受けに失敗したら理由をそのまま返す
    server.once('error', reject);
    // ループバックの 0 番（＝OS が空きを選ぶ）で待ち受ける
    server.listen(0, '127.0.0.1', () => {
      // 割り当てられたアドレス
      const address = server.address();
      // アドレスが読めなければ失敗（fail-closed）
      if (address === null || typeof address === 'string') {
        reject(new Error('ポートを取得できません'));
        return;
      }
      // 閉じてからポート番号を返す（掴んだままだとアプリが同じ番号で待ち受けられない）
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

/**
 * 本番ビルドのアプリを子プロセスとして起こし、`/api/v1/health` が通るまで待つ。
 * @param {object} options 起動の設定
 * @param {number} options.port 待ち受けるポート
 * @param {string} options.platformAdminToken プラットフォーム管理者トークン（テナント作成に要る）
 * @param {string} options.auditSecret 監査ログの HMAC 鍵（**省略可にしない** — 既定で空にすると
 *   停止の段が 503 になり、呼び出し側が渡し忘れたことに気付けない）
 * @param {Record<string, string>} [options.extraEnv] 追加で渡す環境変数
 * @returns {Promise<import('node:child_process').ChildProcess>} 起動した子プロセス
 */
export async function startDemoApp({ port, platformAdminToken, auditSecret, extraEnv = {} }) {
  // 本番ビルドが無ければ測れない（原因の分かる失敗にする）
  if (!existsSync(STANDALONE_SERVER)) {
    throw new Error('本番ビルドがありません: 先に npm run build を実行してください');
  }
  // 子プロセスとして起動する
  const app = spawn(process.execPath, [STANDALONE_SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      // テナント作成に要る（デモの入口）。**使い捨てを呼び出し側が作って渡す**
      PLATFORM_ADMIN_TOKEN: platformAdminToken,
      // 監査ログの HMAC 鍵（停止の段に要る。これも使い捨てを呼び出し側が作って渡す —
      // 開発機の .env の値を使うと、計測が本番相当の鍵に依存する）
      AUDIT_HMAC_SECRET: auditSecret,
      // 上流 LLM は呼ばないので資格情報を子へ渡さない（最小権限。開発機の実キーで課金しない）
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      // 通知の宛先も渡さない（デモの筋では発火しないが、設定を子へ漏らさない）
      NOTIFY_WEBHOOK_URL: '',
      NOTIFY_MAIL_WEBHOOK_URL: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // 起動の失敗を拾えるよう、出力はためておく。**上限を置き、起動できたら購読をやめる** —
  // `output` を読むのは下の 3 つの失敗経路だけなので、起動後の出力は使われないまま溜まる。
  // `bench-concurrency` はこの後 10 秒間 100 並列で叩くので、配備が 1 要求ずつ記録を出す
  // 設定だと計測プロセスのヒープに読まれない文字列が積み上がる
  let output = '';
  // ためる上限（超えたら切り詰めて、**切り詰めた旨を末尾に残す** — 印が無いと
  // 「アプリの出力がそこで終わった＝そこで固まった」と読めてしまう）
  const appendOutput = (chunk) => {
    // 既に切り詰め済みなら何もしない
    if (output.endsWith(STARTUP_OUTPUT_TRUNCATED_NOTE)) return;
    // 足したあとの長さ
    const merged = output + chunk.toString();
    // 上限までなら全部残す
    if (merged.length <= STARTUP_OUTPUT_MAX_CHARS) {
      output = merged;
      return;
    }
    // 上限を超えたら切り詰めて、切り詰めたことを書き添える
    output = merged.slice(0, STARTUP_OUTPUT_MAX_CHARS) + STARTUP_OUTPUT_TRUNCATED_NOTE;
  };
  app.stdout?.on('data', appendOutput);
  app.stderr?.on('data', appendOutput);
  // 起動できたら購読をやめる（診断に要るのは起動までの出力だけ）
  const stopCapturingOutput = () => {
    app.stdout?.off('data', appendOutput);
    app.stderr?.off('data', appendOutput);
  };
  // **`error` を購読する。** 購読しないと spawn の非同期な失敗が uncaughtException になり、
  // `runBench` の try/catch の外でプロセスが死ぬ（結果の JSON を 1 行も出さないので、
  // ゲートには「結果を出していません」という原因の分からない赤だけが残る）
  let spawnError = null;
  app.on('error', (error) => (spawnError = error));
  // 健康確認が通るまで待つ
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  for (;;) {
    // spawn そのものが失敗していたら、待たずに原因を出す
    if (spawnError !== null) throw new Error(`アプリを起動できません: ${spawnError.message}`);
    // **子が先に終了していたら待たずに落ちる** — 接続文字列が不正・ポートが取られた等では
    // すぐ終わるので、60 秒待ってから「起動しませんでした」と言うのは原因を隠すだけ。
    // **シグナルで死んだ場合も見る** — Node は `exitCode` を `null` のままにして
    // `signalCode` を立てるので、`exitCode` だけだと OOM killer の `SIGKILL` や
    // `SIGSEGV` を取り落として 60 秒待ってから原因の分からない失敗になる
    if (app.exitCode !== null || app.signalCode !== null)
      throw new Error(
        `アプリが起動直後に終了しました (${
          app.signalCode !== null ? `シグナル ${app.signalCode}` : `終了コード ${app.exitCode}`
        }):\n${output}`,
      );
    // 期限切れなら原因を添えて落ちる
    if (Date.now() > deadline) {
      app.kill('SIGKILL');
      throw new Error(`アプリが起動しませんでした:\n${output}`);
    }
    // health を叩いてみる
    try {
      const response = await fetchWithTimeout(
        `http://127.0.0.1:${port}${API_PREFIX}/health`,
        {},
        STARTUP_PROBE_TIMEOUT_MS,
      );
      if (response.ok) {
        // 起動できたので出力の購読をやめる（以後の出力は誰も読まない）
        stopCapturingOutput();
        return app;
      }
    } catch {
      // まだ起動していないだけなので待つ
    }
    // 少し待って再試行する
    await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_MS));
  }
}

/**
 * 応答が想定どおりかを確かめて JSON を返す（違えば本文を添えて落とす）。
 * @param {Response} response 受け取った応答
 * @param {number} expected 期待するステータス
 * @param {string} step どの段か（文言に出す）
 * @returns {Promise<Record<string, unknown>>} 応答の JSON
 */
async function expectJson(response, expected, step) {
  // 本文はエラー時の手掛かりにも使うので先に読む
  const text = await response.text();
  // ステータスが違えば原因を添えて落ちる
  if (response.status !== expected) {
    throw new Error(`${step}: ${expected} を期待したが ${response.status} (本文: ${text})`);
  }
  // JSON として読む（読めない応答も失敗）
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${step}: JSON として読めない応答 (${text})`);
  }
}

/**
 * デモの筋を 1 回通す。**通った段の名前をそのまま返す**ので、呼び出し側は
 * 「`DEMO_STEPS` と同じ件数・同じ並びか」を判定できる（段を削って速くした計測を落とせる）。
 * @param {object} options 叩く先
 * @param {string} options.baseUrl アプリの基底 URL（例: `http://127.0.0.1:3000`）
 * @param {string} options.platformAdminToken プラットフォーム管理者トークン
 * @returns {Promise<{ steps: string[]; agentsListed: number; auditRows: number; plan: string; token: string }>} 通った段・確認した値・以後の操作に使うトークン
 */
export async function runDemoFlow({ baseUrl, platformAdminToken }) {
  // 通った段を順に積む
  const steps = [];
  // 1. 配備が生きているか（DB 到達性も含む）
  const health = await fetchWithTimeout(`${baseUrl}${API_PREFIX}/health`);
  const healthBody = await expectJson(health, 200, 'health');
  // `ok` が true でなければ配備が壊れている
  if (healthBody.ok !== true) throw new Error(`health: ok でない (${JSON.stringify(healthBody)})`);
  steps.push('health');
  // 2. テナントを立ち上げる（プラットフォーム管理者だけができる。応答に最初の admin のトークンが入る）
  const tenantResponse = await fetchWithTimeout(`${baseUrl}${API_PREFIX}/tenants`, {
    method: 'POST',
    headers: { authorization: `Bearer ${platformAdminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'デモ運用チーム',
      adminEmail: 'demo-admin@example.com',
      adminName: 'デモ管理者',
    }),
  });
  const created = await expectJson(tenantResponse, 201, 'create-tenant');
  // 以後の操作に使うトークン（平文はこの応答でしか返らない。形は OpenAPI の TenantCreated）
  const token = readString(created, ['adminToken', 'secret'], 'create-tenant');
  steps.push('create-tenant');
  // 以後の要求に付けるヘッダ
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  // 3. エージェントを 1 つ登録する（運用の起点）
  const agentResponse = await fetchWithTimeout(`${baseUrl}${API_PREFIX}/agents`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: 'サポート回答ボット',
      description: '問い合わせに一次回答するエージェント (デモ)',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    }),
  });
  const agent = await expectJson(agentResponse, 201, 'create-agent');
  // 以後の操作に使う id（停止の段で要る）
  const agentId = readString(agent, ['id'], 'create-agent');
  steps.push('create-agent');
  // 4. 一覧に出ることを確かめる（書いたものが読めるか）
  const listResponse = await fetchWithTimeout(`${baseUrl}${API_PREFIX}/agents`, { headers: auth });
  const list = await expectJson(listResponse, 200, 'list-agents');
  // 件数（`items` の長さ。形は OpenAPI の一覧応答が決める）
  const items = Array.isArray(list.items) ? list.items : [];
  steps.push('list-agents');
  // 5. 契約プランと実際に効いている上限を引く（409 / 403 を受けたときの参照先）
  const billingResponse = await fetchWithTimeout(`${baseUrl}${API_PREFIX}/billing`, {
    headers: auth,
  });
  const billing = await expectJson(billingResponse, 200, 'read-billing');
  // プラン名
  const plan = readString(billing, ['plan'], 'read-billing');
  steps.push('read-billing');
  // 6. エージェントを止める（**記録を残す操作**。監査ログの段を意味のあるものにする）
  const stopResponse = await fetchWithTimeout(`${baseUrl}${API_PREFIX}/agents/${agentId}/stop`, {
    method: 'POST',
    headers: auth,
  });
  await expectJson(stopResponse, 200, 'stop-agent');
  steps.push('stop-agent');
  // 7. 監査ログに**その操作が残っている**こと（運用の記録が残る配備であること）
  const auditResponse = await fetchWithTimeout(`${baseUrl}${API_PREFIX}/audit-logs`, {
    headers: auth,
  });
  const audit = await expectJson(auditResponse, 200, 'read-audit-logs');
  // 残っていた行数（**0 件なら「読めた」だけで何も示していない**）
  const auditRows = Array.isArray(audit.items) ? audit.items.length : 0;
  if (auditRows === 0) throw new Error('read-audit-logs: 停止したのに監査ログが 0 件です');
  steps.push('read-audit-logs');
  // 通った段・確認に使った値・以後の操作に使うトークン（同時実行のベンチが使い回す。
  // **使い捨てのテナントのトークンなので持ち出しても害は無いが、ログには出さない**）
  return { steps, agentsListed: items.length, auditRows, plan, token };
}

/**
 * JSON の入れ子から文字列を取り出す（無ければ落ちる）。
 * @param {Record<string, unknown>} body 応答の JSON
 * @param {string[]} path 辿るキー
 * @param {string} step どの段か（文言に出す）
 * @returns {string} 取り出した文字列
 */
function readString(body, path, step) {
  // 現在位置（最初は応答そのもの）
  let current = body;
  // キーを 1 つずつ降りる
  for (const key of path) {
    // オブジェクトでなければ読めない
    if (typeof current !== 'object' || current === null) {
      throw new Error(`${step}: ${path.join('.')} が読めない`);
    }
    current = current[key];
  }
  // 文字列でなければ読めない
  if (typeof current !== 'string' || current === '') {
    throw new Error(`${step}: ${path.join('.')} が文字列でない`);
  }
  return current;
}
