// 本番ビルドのアプリを起動して待つ（Step5）。E2E の webServer と Lighthouse の計測が共有する。
//
// **測る相手は必ず本番ビルド**（`.next/standalone/server.js`）。dev サーバーは毎回その場で
// 変換するので Lighthouse の Performance が実態より悪く出る（基準を測る相手として正しくない）。
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { generateSecret } from '../../src/lib/tokens';

// 本番ビルドの成果物（ベンチと同じ置き場）
const STANDALONE_SERVER = join(process.cwd(), '.next', 'standalone', 'server.js');
// standalone の置き場（静的ファイルをここへ配る）
const STANDALONE_DIR = join(process.cwd(), '.next', 'standalone');
// ビルドが出す静的ファイル（CSS / JS のチャンク）
const BUILD_STATIC_DIR = join(process.cwd(), '.next', 'static');
// 公開ファイル（favicon 等）の置き場
const PUBLIC_DIR = join(process.cwd(), 'public');
// 起動を待つ上限（ミリ秒）
const STARTUP_TIMEOUT_MS = 60_000;
// 起動待ちの確認間隔（ミリ秒）
const STARTUP_POLL_MS = 200;

/** 空いている TCP ポートを 1 つ取る（固定ポートだと CI で衝突する）。 */
export async function freePort(): Promise<number> {
  // 一時的に 0 番で待ち受けて、割り当てられたポートを読む
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      // 割り当てられたアドレス
      const address = server.address();
      // 読めなければ失敗
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

/**
 * standalone の成果物へ静的ファイルを配る。
 *
 * **これが無いと CSS と JS が 404 になる。** Next.js の standalone 出力は `server.js` と
 * サーバ側の依存だけを置き、`.next/static` と `public` は**自分で配る前提**（Dockerfile も
 * 同じ 2 行の COPY をしている）。配らないまま測ると、スタイルの無い HTML を相手に
 * Lighthouse を走らせることになり、**点数も見た目も本番とは別物**になる（実測で、
 * 配る前は Accessibility の target-size が CSS を当てた後の寸法を見ていなかった）。
 */
function placeStaticAssets(): void {
  // ビルドの静的ファイルを standalone の中へ写す（毎回上書きして古い版を残さない）
  if (existsSync(BUILD_STATIC_DIR)) {
    cpSync(BUILD_STATIC_DIR, join(STANDALONE_DIR, '.next', 'static'), { recursive: true });
  }
  // 公開ファイルは無いこともある（あるときだけ写す）
  if (existsSync(PUBLIC_DIR)) {
    cpSync(PUBLIC_DIR, join(STANDALONE_DIR, 'public'), { recursive: true });
  }
}

/**
 * 本番ビルドのアプリを起動し、`/api/v1/health` が通るまで待つ。
 *
 * **開発機の環境変数を子へ素通ししない** — 上流の実キーやプラットフォーム管理者トークンを
 * 渡さない（最小権限。ベンチが同じ手当てをしているのと同じ理由）。
 */
export async function startApp(port: number): Promise<ChildProcess> {
  // 本番ビルドが無ければ測れない（理由を書いて落ちる）
  if (!existsSync(STANDALONE_SERVER)) {
    throw new Error('本番ビルドがありません: 先に npm run build を実行してください');
  }
  // 静的ファイルを配る（配らないと CSS も JS も 404 になる。理由は placeStaticAssets）
  placeStaticAssets();
  // 子プロセスとして起動する
  const app = spawn(process.execPath, [STANDALONE_SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      // 画面の操作（停止・復帰・解決）は監査ログを書くので鍵が要る。**毎回使い捨てを作って渡す**
      // （リポジトリにも開発機の値にも依存しない。未設定だと操作が 503 で断られる）。
      // 仕込みで DB を空にするので、実行をまたいで連鎖を検証する必要は無い
      AUDIT_HMAC_SECRET: generateSecret('apiKey'),
      // 上流は 1 度も呼ばないが、開発機の実キーを子へ渡さない（最小権限）
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      // テナント管理 API を使わないので渡さない
      PLATFORM_ADMIN_TOKEN: '',
      // 通知の宛先も渡さない（画面の操作では通知を出さないが、設定を子へ漏らさない）
      NOTIFY_WEBHOOK_URL: '',
      NOTIFY_MAIL_WEBHOOK_URL: '',
      NOTIFY_SIGNING_SECRET: '',
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
    // 期限切れなら落ちる（ためておいた出力を理由として出す）
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

/** 起動したアプリを止める（計測の後始末。§8 リソースを確実に解放する）。 */
export function stopApp(app: ChildProcess): void {
  // 行儀よく止める（終わらなければプロセスの終了時に OS が片付ける）
  app.kill('SIGTERM');
}
