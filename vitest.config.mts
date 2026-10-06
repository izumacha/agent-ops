// Vitest 設定ヘルパー (defineConfig は補完を効かせるため)
import { defineConfig } from 'vitest/config';
// パス解決用 (Node 標準 path モジュール)
import path from 'path';
// カバレッジの計測対象と除外 (**受け入れ基準の正本は scripts/lib/step6-criteria.mjs**。
// ここへ書き写すと、ゲートが見る定義と実際に測る範囲が静かにずれる)
import { COVERAGE_EXCLUDE, COVERAGE_INCLUDE } from './scripts/lib/step6-criteria.mjs';

// Vitest の設定を defineConfig で記述してエクスポート
export default defineConfig({
  // テスト全体に効くオプション
  test: {
    // Node 環境でテストを実行 (DOM が要るときは 'jsdom' に変える)
    environment: 'node',
    // 拾うテストファイルのパターン (tests/ 配下の *.test.ts のみ)
    include: ['tests/**/*.test.ts'],
    // 各テストファイルの前に走らせる前処理 (契約テストの接続先が専用 DB であることを確かめる)
    setupFiles: ['tests/setup/contract-database-guard.ts'],
    // カバレッジ (Step6 の受け入れ基準④)。**しきい値はここに書かない** —
    // 測る側は JSON を出すだけで、合否は `scripts/gate-step6.mjs` が判定する
    // (ベンチ・Lighthouse と同じ分担。判定を測る側に持たせると「測れていないのに合格」を
    //  測る側だけで作れる)
    coverage: {
      // V8 の計測器を使う (Istanbul より速く、変換を挟まない)
      provider: 'v8',
      // ゲートが読む形で出す (json-summary) ＋ 人が読む用のテキスト
      reporter: ['text-summary', 'json-summary'],
      // 計測対象と除外は受け入れ基準の正本から読む
      include: COVERAGE_INCLUDE,
      exclude: COVERAGE_EXCLUDE,
      // **1 度も import されなかったファイルも 0% として数える** (測らないと
      //  「テストが 1 行も触っていないモジュール」が総計から消えて％が上がる)
      all: true,
    },
  },
  // モジュール解決設定
  resolve: {
    // パスエイリアス: '@/foo' を 'src/foo' に解決 (tsconfig と一致させる)
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
});
