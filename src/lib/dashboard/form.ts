// ダッシュボードの Server Action がフォームと受け渡す形（Step5）。
//
// **`'use server'` のファイルには定数も型も置けない**（async 関数以外を export するとビルドが落ちる）。
// ここに集めるのは、画面（クライアント側のフォーム）・Server Action・テストの 3 者が
// 同じ綴りを共有する必要があるため。項目名を各所に直書きすると、片方だけ変えたときに
// 「送っているのに読まれない」形が静かに生まれる（§6）。
//
// CSRF トークンの項目名は `src/lib/csrf.ts` が持つ（あちらは検証の規則と対になっているため）。

// 操作対象の id を載せる項目名。**どの資源でも同じ綴りを使う** — エージェントでも
// インシデントでも「その画面で操作する 1 件の id」という同じ役目なので、資源ごとに
// 名前を増やすと検証側が項目名の対応表を持つことになる
export const TARGET_ID_FIELD_NAME = 'targetId';

// 「どの操作か」を載せる項目名。**1 つの Server Action で複数の操作を受ける**ために要る —
// 操作ごとに別の Server Action を渡すと、`useActionState` の状態が操作を切り替えた瞬間に
// 捨てられ、成功の文言が一度も見えないまま状態だけが変わる（実測。エージェントの停止 → 復帰で
// ボタンが入れ替わる場面がまさにこれ）。受け取る側は必ず表と突き合わせる（§9 入力は信用しない）
export const INTENT_FIELD_NAME = 'intent';

// Server Action が画面へ返す結果。成功なら message、失敗なら error が入る（両方は入らない）
export interface DashboardActionState {
  error: string | null;
  message: string | null;
}

// 初期状態（`useActionState` に渡す値。画面と Server Action が同じ 1 つを使う）
export const DASHBOARD_ACTION_INITIAL: DashboardActionState = { error: null, message: null };

/**
 * 一覧画面で「操作した行が消える」ときの結果の伝え方（フラッシュ）。
 *
 * **`useActionState` では伝えられない。** 行ごとのフォームは操作が成功すると一覧から消える
 * （未解決だけを出す既定の表示では解決した行がいなくなる）ので、その状態に入っていた文言も
 * 一緒に消える（実測）。そこで成功時だけ同じ画面へリダイレクトし、**クエリの印**を見て
 * サーバ側で文言を描く（POST → リダイレクト → GET の形）。
 *
 * 外から勝手に付けられる値だが、出るのは確認の文言だけで、状態は画面の本文が示している。
 * 知らない値は**何も出さない**（印として扱わない）。
 */
export const RESULT_QUERY_NAME = 'result';

// インシデントを解決したことを表す印（画面と Server Action が同じ 1 つの定義を使う）
export const RESULT_INCIDENT_RESOLVED = 'incident-resolved';
