// Next.js 設定ファイルの型 (補完と型安全のため)
import type { NextConfig } from 'next';

// Next.js のビルド/実行時の挙動を切り替える設定オブジェクト
const nextConfig: NextConfig = {
  // standalone: 必要最小限のサーバ + 依存だけをまとめた出力 (Docker 配布用)
  output: 'standalone',
};

// Next.js が読み取れるよう default export
export default nextConfig;
