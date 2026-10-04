// ダッシュボードの画面と Server Action がセッションを読む入口 (Step5 / ADR-0011)。
//
// **`next/headers` に触るのはこのファイルだけ。** 判定の規則そのものは `src/lib/session.ts`
// (Next 非依存の純粋な部分) が持ち、ここは Cookie の読み書きと「未ログインなら /login へ」の
// 枝だけを担う。分けているのは、規則の側を DB も Next も無しで単体テストできるようにするため。
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getRepos } from '@/data';
import type { UserPrincipal } from '@/lib/api/auth';
import { LOGIN_PATH } from '@/lib/constants';
import { isSameOriginRequest } from '@/lib/csrf';
import {
  SESSION_COOKIE_NAME,
  clearedSessionCookieOptions,
  resolveSessionPrincipal,
  sessionCookieOptions,
} from '@/lib/session';

// ログイン中の主体と、その素のセッショントークン (CSRF トークンの導出に使う)
export interface DashboardSession {
  principal: UserPrincipal;
  // **CSRF トークンを導くためだけに持つ。** 画面へ出すのは導出した値で、この値そのものは出さない
  token: string;
}

/**
 * 要求元が自分自身かを返す。**すべての Server Action が冒頭で呼ぶ**（CSRF 対策の 1 枚目）。
 *
 * ヘッダを読むのはこのファイルだけなので、判定の規則（`isSameOriginRequest`）を呼ぶ側も
 * ここに置く — 画面ごとに `headers()` を呼ぶ形にすると、`Origin` の読み方（ヘッダ名の綴りや
 * 無いときの扱い）が Server Action ごとに割れる。
 */
export async function isSameOriginAction(): Promise<boolean> {
  // ヘッダを読む（Next.js 16 では非同期）
  const headerList = await headers();
  // Origin と Host を突き合わせる（判定の規則は csrf.ts の 1 か所）
  return isSameOriginRequest(headerList.get('origin'), headerList.get('host'));
}

/** Cookie からセッショントークンを読む (無ければ undefined)。 */
export async function readSessionToken(): Promise<string | undefined> {
  // Next.js 16 の cookies() は非同期なので待つ
  const store = await cookies();
  // 値だけを返す (属性は読めない)
  return store.get(SESSION_COOKIE_NAME)?.value;
}

/**
 * ログイン中ならセッションを返し、していなければ `null`。
 * 画面の出し分け（ログイン画面でのリダイレクト判定など）に使う。
 */
export async function currentSession(): Promise<DashboardSession | null> {
  // Cookie を読む
  const token = await readSessionToken();
  // 無ければ未ログイン
  if (token === undefined) return null;
  // データ層を取り、トークンを照合する
  const repos = await getRepos();
  const principal = await resolveSessionPrincipal(token, repos);
  // 照合できなければ未ログイン扱い
  if (principal === null) return null;
  // 主体と素のトークンを返す
  return { principal, token };
}

/**
 * ログインを必須にする。していなければ `/login` へリダイレクトする（この関数は戻らない）。
 *
 * **画面の冒頭で必ず呼ぶ。** 認可の判定をサーバ側で行う唯一の入口で、
 * UI を隠すだけに頼らない（§9）。
 */
export async function requireSession(): Promise<DashboardSession> {
  // 今のセッションを引く
  const session = await currentSession();
  // 無ければログイン画面へ送る (redirect は例外を投げるのでここから先は実行されない)
  if (session === null) redirect(LOGIN_PATH);
  // ログイン中ならそのまま返す
  return session;
}

/** セッション Cookie を張る（Server Action からだけ呼べる）。 */
export async function setSessionCookie(token: string): Promise<void> {
  // Cookie ストアを取る
  const store = await cookies();
  // 属性は session.ts の 1 か所から取る (画面ごとに書き分けない)
  store.set(SESSION_COOKIE_NAME, token, sessionCookieOptions());
}

/** セッション Cookie を消す（ログアウト。Server Action からだけ呼べる）。 */
export async function clearSessionCookie(): Promise<void> {
  // Cookie ストアを取る
  const store = await cookies();
  // 発行時と同じ属性で maxAge 0 を書く (属性が違うと古い Cookie が残る)
  store.set(SESSION_COOKIE_NAME, '', clearedSessionCookieOptions());
}
