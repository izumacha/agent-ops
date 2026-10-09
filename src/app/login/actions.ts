// ログイン / ログアウトの Server Action (Step5 / ADR-0011)。
//
// **ログインは CSRF トークンを要求しない。** トークンはセッションから導くので、まだセッションが
// 無いログイン時には存在しない。代わりに **Origin の照合**で守る（他サイトのフォームから
// 他人のセッションを張らせる = セッション固定攻撃を防ぐ）。
'use server';

import { redirect } from 'next/navigation';
import { getRepos } from '@/data';
import { DASHBOARD_PATH, LOGIN_PATH, UI_TEXT } from '@/lib/constants';
import { logEvent } from '@/lib/log';
import { resolveSessionPrincipal } from '@/lib/session';
import { clearSessionCookie, isSameOriginAction, setSessionCookie } from '@/lib/session-server';

// ログインフォームの状態 (useActionState が受け取る形)。エラーが無ければ null
export interface LoginState {
  error: string | null;
}

/**
 * 貼り付けられたユーザートークンを照合し、通ればセッション Cookie を張ってダッシュボードへ。
 *
 * **失敗の理由は区別しない**（形が違う・失効・期限切れ・ユーザー無効化はすべて同じ文言）。
 * 区別するとトークンの状態を外から探れる（API 側の 401 と同じ方針。ADR-0005）。
 * 画面へ返す文言は区別しないが、**拒否したこと自体はサーバログに残す**
 * （`session.login_rejected`。別オリジンからの送信は `isSameOriginAction` が残す）。
 */
export async function login(_previous: LoginState, formData: FormData): Promise<LoginState> {
  // 他サイトからのフォーム送信を断る (セッション固定攻撃を防ぐ)
  if (!(await isSameOriginAction())) return { error: UI_TEXT.loginFailed };
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
  // 通らなければ理由を区別せず同じ文言を返す。**サーバログには 1 行残す** —
  // Server Action の応答は `agentops_http_responses_total` に乗らないので
  // （`src/lib/metrics.ts` の `UNCOUNTED_RESPONSE_SOURCES`）、ログが唯一の出口になる。
  // 残さないと、貼り付けトークンへの総当たりがどの出口にも現れない
  if (principal === null) {
    // 拒否したことだけを出す（トークンも理由も出さない。理由を区別しないのは上の方針と同じ）
    logEvent('session.login_rejected');
    return { error: UI_TEXT.loginFailed };
  }
  // 通ったので Cookie を張る (属性は session.ts の 1 か所から取る)
  await setSessionCookie(token);
  // ダッシュボードへ送る (redirect は例外を投げるのでここから先は実行されない)
  redirect(DASHBOARD_PATH);
}

/** ログアウトする。Cookie を消してログイン画面へ戻す。 */
export async function logout(): Promise<void> {
  // 他サイトから勝手にログアウトさせられないようにする
  if (!(await isSameOriginAction())) return;
  // Cookie を消す (属性は発行時とそろえる)
  await clearSessionCookie();
  // ログイン画面へ送る
  redirect(LOGIN_PATH);
}
