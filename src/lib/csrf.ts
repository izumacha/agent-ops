// ダッシュボード (Step5) の書き込み操作を守る CSRF 対策。**2 枚重ねる** (ADR-0011):
//   1. 二重送信トークン — Cookie の値とフォームの hidden 項目が一致することを求める
//   2. Origin の照合 — 要求元が自分自身であることを求める
//
// §9 は「`SameSite` クッキーは CSRF トークンを置き換えるものではなく、多層防御として併用する」と
// 明示している。`SameSite=Strict` だけに頼らないのはその通りで、登録ドメインを他サービスと
// 共有していると、サブドメインからの要求では `SameSite` が効かないことがある。
import { randomBytes } from 'node:crypto';
import { secretsEqual } from '@/lib/tokens';

// CSRF トークンを入れる Cookie の名前。セッション Cookie とは別に持つ
export const CSRF_COOKIE_NAME = 'aop_csrf';

// フォームの hidden 項目の名前。画面と検証側がこの 1 つの定義を共有する
export const CSRF_FIELD_NAME = 'csrfToken';

// トークンのバイト数。32 バイト = 256 ビットで、推測できない長さにする
const CSRF_TOKEN_BYTES = 32;

/**
 * 新しい CSRF トークンを作る。`base64url` なので Cookie と HTML のどちらにもそのまま置ける。
 * 乱数は `node:crypto` に任せる (§9: 暗号・乱数を自前実装しない)。
 */
export function createCsrfToken(): string {
  // 暗号論的に安全な乱数を URL 安全な文字列にする
  return randomBytes(CSRF_TOKEN_BYTES).toString('base64url');
}

/**
 * Cookie の値とフォームの値が一致するかを返す。
 *
 * **Cookie 側の空を先に弾くのが要点** — `secretsEqual` は両辺をハッシュしてから比べるので
 * 「空文字列 vs 空文字列」は一致と判定される。この門番が無いと、Cookie を持たない相手が
 * 空の hidden 項目を送るだけで検証を通れる (fail-closed にするため先に落とす)。
 * フォーム側の空は、Cookie が空でない以上ハッシュが一致しないので別の検査を置いていない。
 */
export function csrfTokenMatches(
  cookieToken: string | undefined | null,
  submitted: unknown,
): boolean {
  // Cookie が無い・空なら不一致 (上のコメントの通り、ここを外すと空どうしが一致になる)
  if (!cookieToken) return false;
  // フォームの値が文字列でなければ不一致 (FormData は File も返しうるので型で弾く)
  if (typeof submitted !== 'string') return false;
  // 定数時間で比べる (一致した長さを漏らさない)
  return secretsEqual(cookieToken, submitted);
}

/**
 * 要求元が自分自身かを返す。`Origin` ヘッダのホストが `Host` ヘッダと一致することを求める。
 *
 * **`Origin` が無いときは false** (fail-closed) — 書き込みは必ずフォーム送信から来るので、
 * 現代のブラウザは `Origin` を付ける。付いていない要求を通すと、ヘッダを落とせる相手に
 * この検査がまるごと無効化される。
 */
export function isSameOriginRequest(
  origin: string | undefined | null,
  host: string | undefined | null,
): boolean {
  // どちらかが無ければ判定できないので拒否する。
  // **この 1 行は型でも支えられている** — 外すと下の 2 行が `string | null | undefined` を
  // `URL.canParse` / `new URL` へ渡す形になり `npm run typecheck` が落ちる (実測)。
  // 挙動だけを見る変異では素通りするので、「冗長に見えるから消す」をしないこと
  if (!origin || !host) return false;
  // 解析できない Origin は拒否する (try/catch ではなく判定で分ける。握り潰す catch を作らない)
  if (!URL.canParse(origin)) return false;
  // Origin は絶対 URL なので解析してホスト (ポート込み) を取り出す
  const originHost = new URL(origin).host;
  // Host ヘッダと完全一致することを求める
  return originHost === host;
}
