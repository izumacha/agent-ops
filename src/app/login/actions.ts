// ログイン / ログアウトの Server Action (Step5 / ADR-0011)。
//
// **ログインは CSRF トークンを要求しない。** トークンはセッションから導くので、まだセッションが
// 無いログイン時には存在しない。代わりに **Origin の照合**で守る（他サイトのフォームから
// 他人のセッションを張らせる = セッション固定攻撃を防ぐ）。
'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getRepos } from '@/data';
import { isSameOriginRequest } from '@/lib/csrf';
import { DASHBOARD_PATH, LOGIN_PATH, UI_TEXT } from '@/lib/constants';
import { resolveSessionPrincipal } from '@/lib/session';
import { clearSessionCookie, setSessionCookie } from '@/lib/session-server';

// ログインフォームの状態 (useActionState が受け取る形)。エラーが無ければ null
export interface LoginState {
  error: string | null;
}

/** 要求元が自分自身かを確かめる。違えば `false`（呼び出し側が断る）。 */
async function sameOrigin(): Promise<boolean> {
  // ヘッダを読む (Next.js 16 では非同期)
  const headerList = await headers();
  // Origin と Host を突き合わせる (判定の規則は csrf.ts の 1 か所)
  return isSameOriginRequest(headerList.get('origin'), headerList.get('host'));
}

/**
 * 貼り付けられたユーザートークンを照合し、通ればセッション Cookie を張ってダッシュボードへ。
 *
 * **失敗の理由は区別しない**（形が違う・失効・期限切れ・ユーザー無効化はすべて同じ文言）。
 * 区別するとトークンの状態を外から探れる（API 側の 401 と同じ方針。ADR-0005）。
 */
export async function login(_previous: LoginState, formData: FormData): Promise<LoginState> {
  // 他サイトからのフォーム送信を断る (セッション固定攻撃を防ぐ)
  if (!(await sameOrigin())) return { error: UI_TEXT.loginFailed };
  // 入力を取り出す (FormData は File も返しうるので型で確かめる)
  const submitted = formData.get('token');
  // 文字列でない・空なら入力を促す
  if (typeof submitted !== 'string' || submitted.trim().length === 0) {
    return { error: UI_TEXT.loginTokenRequired };
  }
  // 前後の空白は貼り付け事故なので落とす (トークン本体に空白は入らない)
  const token = submitted.trim();
  // データ層を取り、トークンを照合する
  const repos = await getRepos();
  const principal = await resolveSessionPrincipal(token, repos);
  // 通らなければ理由を区別せず同じ文言を返す
  if (principal === null) return { error: UI_TEXT.loginFailed };
  // 通ったので Cookie を張る (属性は session.ts の 1 か所から取る)
  await setSessionCookie(token);
  // ダッシュボードへ送る (redirect は例外を投げるのでここから先は実行されない)
  redirect(DASHBOARD_PATH);
}

/** ログアウトする。Cookie を消してログイン画面へ戻す。 */
export async function logout(): Promise<void> {
  // 他サイトから勝手にログアウトさせられないようにする
  if (!(await sameOrigin())) return;
  // Cookie を消す (属性は発行時とそろえる)
  await clearSessionCookie();
  // ログイン画面へ送る
  redirect(LOGIN_PATH);
}
