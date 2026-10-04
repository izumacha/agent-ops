// ダッシュボード (Step5) の書き込み操作を守る CSRF 対策。**2 枚重ねる** (ADR-0011):
//   1. 同期トークン — フォームの hidden 項目が「そのセッションから導いた値」と一致することを求める
//   2. Origin の照合 — 要求元が自分自身であることを求める
//
// §9 は「`SameSite` クッキーは CSRF トークンを置き換えるものではなく、多層防御として併用する」と
// 明示している。`SameSite=Strict` だけに頼らないのはその通りで、登録ドメインを他サービスと
// 共有していると、サブドメインからの要求では `SameSite` が効かないことがある。
//
// **トークンはセッションから導出する (2 枚目の Cookie を発行しない)。** Next.js は
// Server Component のレンダリング中に Cookie を書けないので、「ページを描くときに乱数を作って
// Cookie へ置く」形が成立しない。proxy で発行する手もあるが、入口の不変条件 (本文のバッファや
// percent-decode の扱い) に手を入れることになる。
//
// 導出は `HMAC-SHA256(鍵 = セッショントークン, メッセージ = 固定ラベル)`。
//   - 鍵になるセッショントークンは HttpOnly Cookie なので JavaScript から読めず、他サイトからも読めない
//   - よって攻撃者はこの値を計算できない (CSRF トークンに求められる性質そのもの)
//   - HMAC は一方向なので、CSRF トークンが漏れてもセッショントークンは復元できない
//   - 新しい環境変数が要らず、インスタンスを増やしても再起動しても同じ値になる
//   - セッションが変わればトークンも変わる (ログアウト後の古いフォームは通らない)
import { createHmac } from 'node:crypto';
import { secretsEqual } from '@/lib/tokens';

// フォームの hidden 項目の名前。画面と検証側がこの 1 つの定義を共有する
export const CSRF_FIELD_NAME = 'csrfToken';

// 導出に使う固定ラベル。**鍵が同じでも用途ごとに値が別になる**ようにする
// (同じセッショントークンから別の目的の値を作るときに同じ文字列を使い回さない)
const CSRF_DERIVATION_LABEL = 'agent-ops:dashboard-csrf:v1';

/**
 * セッショントークンから、そのセッション専用の CSRF トークンを導く。
 * フォームの hidden 項目に埋める値で、検証側は同じ計算をして比べる。
 */
export function csrfTokenFor(sessionToken: string): string {
  // セッショントークンを鍵に、固定ラベルを HMAC する (base64url なので HTML にそのまま置ける)
  return createHmac('sha256', sessionToken).update(CSRF_DERIVATION_LABEL).digest('base64url');
}

/**
 * フォームから送られた値が、そのセッションから導いた CSRF トークンと一致するかを返す。
 *
 * **セッションが無い (空の) 状態を先に弾くのが要点** — 弾かないと「鍵が空の HMAC」という
 * 誰でも計算できる値が正解になり、未ログインの相手が自分で作った値で検証を通れる (fail-closed)。
 */
export function csrfTokenMatches(
  sessionToken: string | undefined | null,
  submitted: unknown,
): boolean {
  // セッションが無い・空なら不一致 (上のコメントの通り、ここを外すと誰でも計算できる値が通る)
  if (!sessionToken) return false;
  // フォームの値が文字列でなければ不一致 (FormData は File も返しうるので型で弾く)
  if (typeof submitted !== 'string') return false;
  // 期待値をその場で導いて、定数時間で比べる (一致した長さを漏らさない)
  return secretsEqual(csrfTokenFor(sessionToken), submitted);
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
