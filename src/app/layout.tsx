// Next.js のメタデータ型 (title 等の補完のため)
import type { Metadata } from 'next';
// アプリ名の一元管理
import { APP_NAME } from '@/lib/constants';

// ページ共通のメタデータ (ブラウザのタブ名など)
export const metadata: Metadata = {
  title: APP_NAME,
  description: 'AI エージェントの登録・権限・コスト・品質・停止を管理する運用基盤',
};

// 全ページを包むルートレイアウト (html/body を描画する)
export default function RootLayout({ children }: { children: React.ReactNode }) {
  // 文書の言語は日本語 (§7 a11y: lang は実際の UI 言語に一致させる)
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
