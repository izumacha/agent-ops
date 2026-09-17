// Next.js が用意する Core Web Vitals 向け ESLint ルール集
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
// Next.js + TypeScript 用の ESLint ルール集
import nextTypescript from 'eslint-config-next/typescript';

// ESLint 9 のフラットコンフィグ (配列で複数のルール塊を結合する書き方)
const config = [
  {
    // Lint 対象から除外するパス (生成物・依存・成果物)
    ignores: [
      '.next/**', // Next.js のビルド出力
      'node_modules/**', // npm の依存パッケージ
      'src/generated/**', // Prisma / OpenAPI の生成物
    ],
  },
  // Next 推奨ルールを展開してマージ
  ...nextCoreWebVitals,
  // TypeScript 向けルールを展開してマージ
  ...nextTypescript,
  {
    // 適用対象: src 配下の TypeScript / TSX ファイル全体 (除外なし)
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      // _ プレフィックスの変数・引数は意図的な未使用として警告しない (Proxy トラップの _target 等)
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_', // 関数引数の _ プレフィックスを無視
          varsIgnorePattern: '^_', // 変数宣言の _ プレフィックスを無視
          destructuredArrayIgnorePattern: '^_', // 分割代入の _ プレフィックスを無視
        },
      ],
    },
  },
  {
    // 適用対象: src 配下の TypeScript / TSX ファイル全体
    files: ['src/**/*.{ts,tsx}'],
    // 例外: Prisma クライアントの結線箇所 (composition root) だけは生成物の直接 import を許可する
    ignores: ['src/lib/prisma.ts', 'src/lib/prisma-client.ts'],
    rules: {
      // 指定したモジュールへの import をエラー化するルール
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Prisma の生成物への直接 import を禁止対象にする。エイリアス形 (@/generated/prisma) だけでなく
              // 相対パス形 (../generated/prisma) も捕まえる (エイリアスだけだと書き方 1 つで素通りする)
              group: [
                '@/generated/prisma',
                '@/generated/prisma/*',
                '**/generated/prisma',
                '**/generated/prisma/*',
              ],
              // 違反したときに開発者へ表示するメッセージ (代わりに使うべき場所を案内)
              message:
                'Prisma 生成物の直接 import は禁止。enum/型は正準である @/domain/types を使うこと。',
            },
          ],
        },
      ],
    },
  },
];

// ESLint が読み取れるよう default export
export default config;
