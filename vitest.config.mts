// Vitest 設定ヘルパー (defineConfig は補完を効かせるため)
import { defineConfig } from 'vitest/config';
// パス解決用 (Node 標準 path モジュール)
import path from 'path';

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
  },
  // モジュール解決設定
  resolve: {
    // パスエイリアス: '@/foo' を 'src/foo' に解決 (tsconfig と一致させる)
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
});
