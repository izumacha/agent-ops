// 認証済み画面の共通レイアウト (Step5)。
//
// **ここで認証を強制する。** 配下のすべての画面が通るので、画面ごとに書き忘れることがない。
// ただし **各 Server Action は自分でも認可を確かめる**（レイアウトはルーティングの枝であって
// 認可の代わりにならない。§9「UI を隠すだけに頼らない」）。
import Link from 'next/link';
import {
  AGENTS_PATH,
  APP_NAME,
  DASHBOARD_PATH,
  INCIDENTS_PATH,
  ROLE_LABELS,
  UI_TEXT,
} from '@/lib/constants';
import { requireSession } from '@/lib/session-server';
import { logout } from '../login/actions';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // 未ログインならここで /login へ送られる (この行より下は実行されない)
  const { principal } = await requireSession();
  // 画面の骨組みを描く
  return (
    <>
      {/* 本文へ飛ぶスキップリンク。キーボード利用者が毎回ナビを辿らずに済む (§7) */}
      <a className="skip-link" href="#main">
        {UI_TEXT.skipToContent}
      </a>
      <div className="shell">
        <header className="header">
          {/* アプリ名はダッシュボードへのリンクにする */}
          <strong>
            <Link href={DASHBOARD_PATH}>{APP_NAME}</Link>
          </strong>
          {/* ナビゲーション。リストにして読み上げ順を明示する (§7 セマンティック HTML) */}
          <nav aria-label={UI_TEXT.navDashboard}>
            <ul>
              <li>
                <Link href={DASHBOARD_PATH}>{UI_TEXT.navDashboard}</Link>
              </li>
              <li>
                <Link href={AGENTS_PATH}>{UI_TEXT.navAgents}</Link>
              </li>
              <li>
                <Link href={INCIDENTS_PATH}>{UI_TEXT.navIncidents}</Link>
              </li>
            </ul>
          </nav>
          {/* 誰として見ているか。**役割は日本語ラベルで出す**（enum の値を画面に出さない） */}
          <span className="identity">
            {principal.user.name}（{ROLE_LABELS[principal.user.role]}）
            {/* ログアウトは副作用があるので GET のリンクにしない (§9) */}
            <form action={logout}>
              <button type="submit">{UI_TEXT.logout}</button>
            </form>
          </span>
        </header>
        {/* 本文。スキップリンクの着地点でもある */}
        <main id="main">{children}</main>
      </div>
    </>
  );
}
