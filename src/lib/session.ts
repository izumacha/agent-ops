// ダッシュボード (Step5) のセッション。**Cookie に入れるのはユーザートークンそのもの**で、
// 照合は API と同じ `authenticateUserToken` を通す (ADR-0011)。
//
// なぜこの形か: `User` にパスワード列が無く、ADR-0005 が「ブラウザ向けのログインは
// Cookie → ユーザートークンの形で**この ADR の上に重ねる** (置き換えない)」と決めている。
// 別のセッション表を作ると照合の規則が 2 つになり、失効・期限切れ・ユーザー無効化の扱いが
// 片方だけ直る形に育つ。トレードオフ (盗まれたときの影響・不透明なセッション ID への移行) は
// ADR-0011 に書いた。
import type { Repositories } from '@/data';
import { type UserPrincipal, authenticateUserToken } from '@/lib/api/auth';
import { ApiError } from '@/lib/api/errors';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { isUserToken } from '@/lib/tokens';

// セッション Cookie の名前。**ここが唯一の定義**で、画面・ログアウト・E2E・撮影スクリプトが参照する
export const SESSION_COOKIE_NAME = 'aop_session';

// Cookie の寿命 (秒)。12 時間。トークン自身の有効期限 (既定 90 日) より**短く**しておき、
// 共有端末に開いたままの画面が翌日もそのまま使える状態を避ける
export const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 12;

// Cookie に付ける属性。Next.js の `cookies().set()` にそのまま渡せる形にしている
export interface SessionCookieOptions {
  // JavaScript から読めなくする (XSS でトークンを抜かれないようにする)
  httpOnly: true;
  // HTTPS 以外へ送らない (本番だけ true。ローカルの http では付けないと Cookie が保存されない)
  secure: boolean;
  // 他サイトからの遷移では送らない。**CSRF トークンの代わりではなく多層防御の 1 枚** (§9)
  sameSite: 'strict';
  // サイト全体で使う
  path: '/';
  // 寿命 (秒)
  maxAge: number;
}

// 本番かどうか (本番だけ Secure を付ける)。判定を 1 か所に閉じる
function isProductionRuntime(): boolean {
  // NODE_ENV が production のときだけ本番扱い
  return process.env.NODE_ENV === 'production';
}

/** セッション Cookie に付ける属性を組み立てる。`production` を省略すると実行環境から判定する。 */
export function sessionCookieOptions(
  production: boolean = isProductionRuntime(),
): SessionCookieOptions {
  // 属性をまとめて返す (値はすべて上の定数と引数から導く)
  return {
    httpOnly: true,
    secure: production,
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  };
}

/**
 * ログアウト用の Cookie 属性。`maxAge: 0` で即時に失効させる。
 * **属性は発行時と同じにそろえる** — path や sameSite が違うと「別の Cookie」として扱われ、
 * 古い Cookie が消えずに残る (ログアウトしたのにログインしたまま、という形になる)。
 */
export function clearedSessionCookieOptions(
  production: boolean = isProductionRuntime(),
): SessionCookieOptions {
  // 発行時の属性をそのまま使い、寿命だけ 0 にする
  return { ...sessionCookieOptions(production), maxAge: 0 };
}

/**
 * Cookie から取り出したトークンを照合し、有効ならユーザー主体を返す。
 * **無い・形が違う・無効なトークンはすべて `null`**（画面側は `/login` へ送る）。
 *
 * `authenticateUserToken` は無効なトークンを 401 の `ApiError` で表すので、ここで `null` に写す。
 * **401 以外の例外は再送出する** — DB 障害を「ログアウト」として扱うと、原因が画面から消える (§6)。
 */
export async function resolveSessionPrincipal(
  token: string | undefined | null,
  repos: Repositories,
  now: Date = new Date(),
): Promise<UserPrincipal | null> {
  // Cookie が無ければ未ログイン
  if (!token) return null;
  // ユーザートークンの形でなければ DB を引かずに未ログインとする
  // (プラットフォーム管理者トークンや API キーをここで受け付けない。資格情報の系統を混ぜない)
  if (!isUserToken(token)) return null;
  try {
    // ハッシュで照合する (失効・期限切れ・ユーザー無効化はすべて 401 になる)
    return await authenticateUserToken(token, repos, now);
  } catch (error) {
    // 401 だけを「未ログイン」に写す
    if (error instanceof ApiError && error.status === HTTP_STATUS.UNAUTHORIZED) return null;
    // それ以外 (DB 障害など) は呼び出し元へ投げ、画面は 500 として扱う
    throw error;
  }
}
