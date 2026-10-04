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

// Server Action が画面へ返す結果。成功なら message、失敗なら error が入る（両方は入らない）
export interface DashboardActionState {
  error: string | null;
  message: string | null;
}

// 初期状態（`useActionState` に渡す値。画面と Server Action が同じ 1 つを使う）
export const DASHBOARD_ACTION_INITIAL: DashboardActionState = { error: null, message: null };
