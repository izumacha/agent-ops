// Next.js 設定ファイルの型 (補完と型安全のため)
import type { NextConfig } from 'next';
// 入口でバッファしてよい本文の上限 (値の正本。ここに数値を書き写さない)
import { ENTRY_MAX_BODY_BYTES } from './src/lib/body-limits';

// Next.js のビルド/実行時の挙動を切り替える設定オブジェクト
const nextConfig: NextConfig = {
  // standalone: 必要最小限のサーバ + 依存だけをまとめた出力 (Docker 配布用)
  output: 'standalone',
  // `next dev` が CLAUDE.md へ独自のルールブロックを追記するのを止める。
  // 追記されるブロックの本文は「差分から消しても再作成されるので、自分の変更と一緒にコミットしておけ」と
  // 書いており、**ツールの出力が正本の指示ファイルへ指示文を注入する**形になる。
  // CLAUDE.md は原本テンプレートと同期する正本なので、機械に書き換えさせない
  agentRules: false,
  // 実験的な設定
  experimental: {
    // 入口 (src/proxy.ts) でバッファする本文の上限。既定は 10 MiB で、**認証より前に**読まれるため
    // 未認証の相手が 1 接続あたりその分のヒープを握れる。アプリの本文上限から導いて絞る
    proxyClientMaxBodySize: ENTRY_MAX_BODY_BYTES,
  },
};

// Next.js が読み取れるよう default export
export default nextConfig;
