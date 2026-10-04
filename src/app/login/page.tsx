// ログイン画面 (Step5)。ユーザートークンを貼り付けてセッション Cookie を張る。
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { APP_NAME, DASHBOARD_PATH, UI_TEXT } from '@/lib/constants';
import { currentSession } from '@/lib/session-server';
import LoginForm from './login-form';

// ブラウザのタブに出す題名
export const metadata: Metadata = {
  title: `${UI_TEXT.loginTitle} | ${APP_NAME}`,
};

export default async function LoginPage() {
  // **既にログインしているならダッシュボードへ送る**（ログイン画面に留まる意味が無い）
  if ((await currentSession()) !== null) redirect(DASHBOARD_PATH);
  // フォームを描く
  return (
    <main className="shell" id="main">
      {/* 見出しは h1 から始める (§7 階層を飛ばさない) */}
      <h1>
        {APP_NAME} {UI_TEXT.loginTitle}
      </h1>
      {/* 何を貼ればよいかを説明する */}
      <p>{UI_TEXT.loginDescription}</p>
      {/* 入力と送信 (エラー表示のため Client Component) */}
      <LoginForm />
    </main>
  );
}
