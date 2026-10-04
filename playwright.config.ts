// Playwright の設定（Step5）。受け入れ基準「主要 5 画面の E2E 全 pass」を測る 1 本のスイート。
//
// **chromium だけ**を使う（ブラウザ差の検証は Step5 の基準ではない。CI の時間も増やさない）。
// **直列で流す**（`workers: 1`）— E2E は同じテナントの状態を書き換える（停止 → 復帰 → 解決）ので、
// 並列にすると互いの変更を読んで理由の分からない赤が出る。
//
// **アプリは globalSetup が起動する**（`webServer` を使わない）— 仕込み（DB を空にして行を作る）と
// 起動の順序を 1 か所で決める必要があり、ポートも実行ごとに空きを取るため。
import { defineConfig } from '@playwright/test';
import { chromiumExecutablePath } from './e2e/lib/chromium';

export default defineConfig({
  // テストの置き場
  testDir: './e2e',
  // 仕込みとアプリの起動（戻り値が後始末になる）
  globalSetup: './e2e/global-setup.ts',
  // **並列にしない**（理由は冒頭）
  workers: 1,
  fullyParallel: false,
  // 失敗したら理由を見たいので、再試行は CI でだけ 1 回
  retries: process.env.CI === undefined ? 0 : 1,
  // 1 本あたりの上限（本番ビルドの初回描画を含むので十分な余裕を取る）
  timeout: 60_000,
  // 既定は読みやすい一覧。ゲートは `--reporter=json` を足して結果を機械で読む
  reporter: 'list',
  use: {
    // 失敗したときだけ痕跡を残す（毎回残すと CI の成果物が膨らむ）
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        // **ブラウザをダウンロードできない環境では既存の Chromium を指す**（判定は 1 か所に集約）
        launchOptions: { executablePath: chromiumExecutablePath() },
      },
    },
  ],
});
