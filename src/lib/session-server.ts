// ダッシュボードの画面と Server Action がセッションを読む入口 (Step5 / ADR-0011)。
//
// **`next/headers` に触るのはこのファイルだけ。** 判定の規則そのものは `src/lib/session.ts`
// (Next 非依存の純粋な部分) が持ち、ここは Cookie の読み書きと「未ログインなら /login へ」の
// 枝だけを担う。分けているのは、規則の側を DB も Next も無しで単体テストできるようにするため。
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getRepos } from '@/data';
import { canPerform } from '@/domain/rbac';
import type { UserPrincipal } from '@/lib/api/auth';
import { LOGIN_PATH } from '@/lib/constants';
import { isSameOriginRequest } from '@/lib/csrf';
import { logEvent } from '@/lib/log';
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
 *
 * **断ったことはここで 1 行残す。** Server Action の応答は
 * `agentops_http_responses_total` に乗らない（`src/lib/metrics.ts` の
 * `UNCOUNTED_RESPONSE_SOURCES`）ので、ログが唯一の出口になる。**判定の呼び出し側ではなく
 * ここで出す** — 画面ごとに書くと、Server Action を足した人が出し忘れたぶんだけ黙る。
 *
 * **毎回出す**（1 プロセスに 1 度にしない）。設定の通知と違い、率そのものが信号なので
 * 間引くと意味が消える。量は前段のレート制限で抑える（理由は `src/app/login/actions.ts`）。
 */
export async function isSameOriginAction(): Promise<boolean> {
  // ヘッダを読む（Next.js 16 では非同期）
  const headerList = await headers();
  // Origin と Host を突き合わせる（判定の規則は csrf.ts の 1 か所）
  const sameOrigin = isSameOriginRequest(headerList.get('origin'), headerList.get('host'));
  // 断ったときだけ 1 行残す（値そのものは出さない。出してよい形は定型文だけ）
  if (!sameOrigin) logEvent('session.cross_origin_action');
  // 判定をそのまま返す
  return sameOrigin;
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
 *
 * **1 リクエストにつき 1 回しか照合しない**（React の `cache` で畳む）。レイアウトと各画面が
 * それぞれ `requireSession()` を呼ぶ構成なので、畳まないと 1 回の描画でトークンのハッシュ照合と
 * DB の問い合わせが 2 回走る（詳細画面では CSRF の HMAC も 2 回）。§8「同じ計算・取得を
 * 繰り返さない」。**レイアウトと画面の両方で確かめる形は変えない** — あれは多層防御で、
 * 畳んでいるのは問い合わせの回数だけ。
 */
export const currentSession = cache(async (): Promise<DashboardSession | null> => {
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
});

/**
 * ログインを必須にし、**閲覧の権限（`view`）まで確かめる**。
 * ログインしていなければ `/login` へ、権限が無ければ 404 を返す（どちらもこの関数は戻らない）。
 *
 * **画面の冒頭で必ず呼ぶ。** 認可の判定をサーバ側で行う唯一の入口で、
 * UI を隠すだけに頼らない（§9）。
 *
 * **`view` も見るのが要点。** 同じ数字を返す `GET /usage/daily` は `requireAction(principal,
 * 'view')` を通すのに、画面側が認証だけで止まっていると、両者は「現在の許可表ではたまたま
 * 3 役割すべてが `view` を持つ」という偶然で一致しているだけになる。Step6 で `view` を持たない
 * 役割（課金だけを見る主体など）を足した瞬間、API は 403 なのに画面はコスト・品質・稼働率を
 * 出し CSV まで落とせる、という fail-open が黙って生まれる。
 *
 * **権限が無いときは 404。** このリポジトリは「見てよい資源でなければ存在を隠す」
 * （他テナントの資源は 403 ではなく 404。ADR-0002）方針なので、画面でも同じにそろえる。
 */
export async function requireSession(): Promise<DashboardSession> {
  // 今のセッションを引く
  const session = await currentSession();
  // 無ければログイン画面へ送る (redirect は例外を投げるのでここから先は実行されない)
  if (session === null) redirect(LOGIN_PATH);
  // 閲覧の権限が無ければ 404 にする（notFound も例外を投げるのでここから先は実行されない）
  if (!canPerform(session.principal.user.role, 'view')) notFound();
  // ログイン中かつ閲覧できるならそのまま返す
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
