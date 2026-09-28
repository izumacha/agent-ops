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
    // 適用対象: _ プレフィックスの例外は **src と tests だけ**。
    // tests には `it.each` のラベル引数 (`_label`) が多数あり、`--max-warnings=0` の下で
    // 「意図的な未使用」を綴りで表せないと CI が落ちるので必要。
    // **scripts には効かせない** — `scripts/lib/bench-criteria.mjs` と
    // `tests/gate-scripts.test.ts` が「呼び出しを消すと import した名前が未使用になって eslint が
    // 捕まえる」を前提にしているので、`import { X as _X }` で黙らせられる形を作らない
    // (実測で、その改名と組み合わせるとベンチの判定を消しても全件緑になった)。
    // scripts で `_` を使いたくなった時点で、前提への影響を考えたうえで広げる
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
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
    // 以下は **src 限定**のまま (対象を広げると意味が変わる)
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      // 値をそのまま SQL へ混ぜる Prisma の API を禁止する (タグ付きテンプレートの $queryRaw を使う)。
      // これは編集中にすぐ気付くための二次的な網で、値の妥当性は実行時のガード
      // (src/lib/raw-sql-guard.ts) が担う。1 段の間接化 (分割代入・別名・計算添字) は捕まえられない
      'no-restricted-syntax': [
        'error',
        {
          // 値を素通しするメソッドの読み取り (レシーバは問わない)
          selector: 'MemberExpression[property.name=/^\\$(query|execute)RawUnsafe$/]',
          message:
            '値を素通しする生 SQL は禁止。タグ付きテンプレートの $queryRaw / $executeRaw を使うこと (パラメータ化される)。',
        },
        {
          // SQL 断片を作る Prisma.raw / Prisma.sql (レシーバが Prisma のときだけ。名前だけで禁じると
          // 無関係なオブジェクトの .raw / .sql まで落ち、誤検知がいずれ検査を緩める圧力になる)
          selector: "MemberExpression[object.name='Prisma'][property.name=/^(raw|sql)$/]",
          message:
            'SQL 断片 (Prisma.raw / Prisma.sql) の埋め込みは禁止。値はタグ付きテンプレートの ${} で渡すこと。',
        },
      ],
    },
  },
  {
    // 適用対象: src 配下の TypeScript / TSX ファイル全体
    files: ['src/**/*.{ts,tsx}'],
    // 例外: Prisma クライアントの結線箇所と prisma アダプタ (Ports & Adapters の Adapter 側) だけは生成物の直接 import を許可する
    ignores: ['src/lib/prisma.ts', 'src/lib/prisma-client.ts', 'src/data/adapters/prisma/**'],
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
