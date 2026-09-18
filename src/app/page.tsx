// アプリ名の一元管理
import { APP_NAME } from '@/lib/constants';

// トップページ (いまは案内だけの骨組み。Step5 でダッシュボードに置き換える)
export default function HomePage() {
  // 見出しと現在の段階を表示する
  return (
    <main>
      <h1>{APP_NAME}</h1>
      <p>AI エージェントの登録・権限・コスト・品質・停止を管理する運用基盤です。</p>
      <p>
        現在は Step1（エージェント台帳・権限）まで実装済みです。ロードマップは{' '}
        <code>docs/roadmap.md</code> を参照してください。
      </p>
    </main>
  );
}
