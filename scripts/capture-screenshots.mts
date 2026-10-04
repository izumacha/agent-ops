// README 掲載用のスクリーンショットとデモ動画を自動撮影する（§15 の「見せ方」）。
//   DATABASE_URL='postgresql://…/agent_ops_step5_contract?schema=app' npm run capture:screenshots
//
// **開発 DB では走らない** — 仕込みで全テーブルを TRUNCATE するので、契約テストやベンチと同じ
// 「専用 DB の名前（末尾 `_contract`）」の判定を通らなければ 1 行も書かずに落ちる（fail-closed）。
//
// **写すのは仕込んだダミーデータだけ**（§15 / §9）。テナント名・ユーザー名・メールアドレスは
// `e2e/lib/fixture.ts` が決める架空の値で、実在のアドレスは 1 つも入らない。
// **ユーザートークンは画面に出ない** — ログインの入力欄は `type="password"` なので、
// 動画でも伏せ字になる（録画に資格情報を写さない）。
//
// **撮る画面の一覧とファイル名は `scripts/lib/step5-criteria.mjs` が正本**（E2E と Lighthouse と
// 同じ一覧）。別に並べると「E2E はあるのにスクショが無い画面」が静かに生まれる。
//
// **拡張子が `.mts` なのは ESM として実行する必要があるため**（Lighthouse の計測と同じ理由）。
import 'dotenv/config';
import { chromium } from '@playwright/test';
import { cpSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { STEP5_SCREENS, screenPath } from './lib/step5-criteria.mjs';
import { chromiumExecutablePath } from '../e2e/lib/chromium';
import { freePort, startApp, stopApp } from '../e2e/lib/app';
import { seedE2eFixture } from '../e2e/lib/fixture';
import { SESSION_COOKIE_NAME } from '../src/lib/session';
import { AGENTS_PATH, DASHBOARD_PATH, INCIDENTS_PATH, UI_TEXT } from '../src/lib/constants';

// 画像の置き場（§15: `docs/screenshots/` 配下）
const SHOTS_DIR = join(process.cwd(), 'docs', 'screenshots');
// デモ動画のファイル名（システムに ffmpeg が無いので GIF ではなく webm。§15 は「GIF/動画」）
const DEMO_FILE = 'demo.webm';
// 録画の一時置き場（Playwright が勝手な名前で書くので、あとで 1 本だけ写す）
const VIDEO_TMP_DIR = join(process.cwd(), 'test-results', 'demo-video');
// 画面の幅（§15: 幅 1280px 目安）
const VIEWPORT = { width: 1280, height: 800 };
// **日本語の利用者として撮る。** 日付入力の表示形式はブラウザのロケールが決めるので、
// 既定（en-US）のままだと日本語 UI のスクショに `10/04/2026` と出る（実測）
const BROWSER_CONTEXT = { viewport: VIEWPORT, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' } as const;
// デモの操作のあいだに置く待ち（人が目で追える速さにする）
const STEP_PAUSE_MS = 900;
// 読み込み後に描画が落ち着くのを待つ時間（スクショが描画途中にならないように）
const SETTLE_MS = 300;

/** 撮影した画像が空でないことを確かめる（0 バイトのファイルを README に載せない）。 */
function assertNotEmpty(path: string): void {
  // 大きさを読む（無ければ例外になる）
  const size = statSync(path).size;
  // 空なら撮れていない（fail-closed）
  if (size === 0) throw new Error(`撮影に失敗しました（0 バイト）: ${path}`);
}

// 撮影本体
async function main(): Promise<void> {
  // 専用 DB を空にして、画面に出すダミーデータを仕込む
  const seed = await seedE2eFixture();
  // 空いているポートでアプリ（本番ビルド）を起動する
  const port = await freePort();
  const app = await startApp(port);
  // 画面の URL を組み立てる土台
  const baseUrl = `http://127.0.0.1:${port}`;
  // ブラウザを起動する（ダウンロードできない環境では既存の Chromium を指す）
  const browser = await chromium.launch({ executablePath: chromiumExecutablePath() });
  try {
    // 置き場を用意する
    mkdirSync(SHOTS_DIR, { recursive: true });
    // ── 静止画 ──
    // セッション Cookie を張った文脈（認証が要る画面のため）
    const context = await browser.newContext(BROWSER_CONTEXT);
    await context.addCookies([{ name: SESSION_COOKIE_NAME, value: seed.token, url: baseUrl }]);
    const page = await context.newPage();
    // **Cookie を張らない文脈も用意する** — ログイン画面はログイン済みだと
    // ダッシュボードへリダイレクトするので、同じ文脈で撮ると**別の画面が写る**（実測で、
    // login.png がダッシュボードと 1 バイト違わぬ同じ画像になっていた）
    const anonymousContext = await browser.newContext(BROWSER_CONTEXT);
    const anonymousPage = await anonymousContext.newPage();
    // 画面一覧のとおりに撮る（一覧が唯一の宣言。ここで並べ直さない）
    for (const screen of STEP5_SCREENS) {
      // 認証が要る画面はログイン済みの文脈、要らない画面は未ログインの文脈で開く
      const target = screen.auth ? page : anonymousPage;
      // その画面を開く
      await target.goto(`${baseUrl}${screenPath(screen, seed)}`);
      // 描き終わるのを待つ（描画途中を撮らない）。**`networkidle` は使わない** —
      // 本番の Next.js は接続を開いたままにするので待ちが終わらない（実測で 30 秒で時間切れ）
      await target.waitForLoadState('load');
      await target.waitForTimeout(SETTLE_MS);
      // **開いた URL が指定のままであることを確かめる**（リダイレクトで別の画面を撮らない）
      const expected = `${baseUrl}${screenPath(screen, seed)}`;
      if (target.url() !== expected) {
        throw new Error(`${screen.file}: ${expected} のはずが ${target.url()} を開いています`);
      }
      // 置き場へ書き、空でないことを確かめる
      const path = join(SHOTS_DIR, screen.file);
      await target.screenshot({ path, fullPage: false });
      assertNotEmpty(path);
      // 何を撮ったかを残す（標準出力は人向け）
      console.log(`[capture] ${screen.file} ← ${screen.title}`);
    }
    await context.close();
    await anonymousContext.close();
    // ── デモ動画 ──
    // 前回の録画が残っていると 2 本目を拾ってしまうので消す
    rmSync(VIDEO_TMP_DIR, { recursive: true, force: true });
    // 録画する文脈（**Cookie を張らない** — ログインの操作から見せる）
    const demoContext = await browser.newContext({
      ...BROWSER_CONTEXT,
      recordVideo: { dir: VIDEO_TMP_DIR, size: VIEWPORT },
    });
    const demoPage = await demoContext.newPage();
    // 1. ログイン（入力欄は type="password" なのでトークンは伏せ字になる）
    await demoPage.goto(`${baseUrl}/login`);
    await demoPage.waitForTimeout(STEP_PAUSE_MS);
    await demoPage.getByLabel(UI_TEXT.loginTokenLabel).fill(seed.token);
    await demoPage.getByRole('button', { name: UI_TEXT.loginSubmit }).click();
    // 2. ダッシュボード（コスト・稼働率・未解決インシデント）
    await demoPage.getByRole('heading', { name: UI_TEXT.dashboardTitle }).waitFor();
    await demoPage.waitForTimeout(STEP_PAUSE_MS);
    // 3. インシデント一覧（ガードレールの発火が記録されている）
    await demoPage.goto(`${baseUrl}${INCIDENTS_PATH}`);
    await demoPage.waitForTimeout(STEP_PAUSE_MS);
    // 4. エージェント詳細で停止する
    await demoPage.goto(`${baseUrl}${AGENTS_PATH}/${seed.agentId}`);
    await demoPage.waitForTimeout(STEP_PAUSE_MS);
    await demoPage.getByRole('button', { name: UI_TEXT.agentStop }).click();
    await demoPage.getByText(UI_TEXT.agentStopped).waitFor();
    await demoPage.waitForTimeout(STEP_PAUSE_MS);
    // 5. 復帰させる（止めたままにしない）
    await demoPage.getByRole('button', { name: UI_TEXT.agentResume }).click();
    await demoPage.getByText(UI_TEXT.agentResumed).waitFor();
    await demoPage.waitForTimeout(STEP_PAUSE_MS);
    // 6. インシデントを解決する
    await demoPage.goto(`${baseUrl}${INCIDENTS_PATH}`);
    await demoPage.getByRole('button', { name: UI_TEXT.incidentResolve }).click();
    await demoPage.getByText(UI_TEXT.incidentResolved).waitFor();
    await demoPage.waitForTimeout(STEP_PAUSE_MS);
    // 7. ダッシュボードへ戻る（未解決が 0 になっている）
    await demoPage.goto(`${baseUrl}${DASHBOARD_PATH}`);
    await demoPage.waitForTimeout(STEP_PAUSE_MS);
    // 録画は文脈を閉じたときに書き出される
    const video = demoPage.video();
    // 録画が無ければ設定が効いていない（fail-closed）
    if (video === null) throw new Error('録画が有効になっていません');
    await demoContext.close();
    // 書き出された 1 本を置き場へ写す
    const demoPath = join(SHOTS_DIR, DEMO_FILE);
    cpSync(await video.path(), demoPath);
    assertNotEmpty(demoPath);
    console.log(`[capture] ${DEMO_FILE} ← ログイン→停止→復帰→解決`);
  } finally {
    // 起動したものを必ず片付ける（§8 リソースを確実に解放する）
    await browser.close();
    stopApp(app);
  }
}

// 失敗は理由を出して非 0 終了（撮れていないのに緑にしない）
main().catch((error: unknown) => {
  // 原因を残す（§6 握り潰さない）
  console.error('[capture] 撮影に失敗しました:', error instanceof Error ? error.message : error);
  // 非 0 終了
  process.exitCode = 1;
});
