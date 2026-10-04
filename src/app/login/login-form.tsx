// ログインフォーム。**失敗の文言を出すために Client Component にしている**
// （`useActionState` でサーバの戻り値を受け取る）。入力そのものはサーバへ送って検証する。
'use client';

import { useActionState } from 'react';
import { UI_TEXT } from '@/lib/constants';
import { type LoginState, login } from './actions';

// 初期状態 (まだ送信していないのでエラーは無い)
const INITIAL_STATE: LoginState = { error: null };

export default function LoginForm() {
  // Server Action と状態を結ぶ (state にサーバが返したエラーが入る)
  const [state, formAction, pending] = useActionState(login, INITIAL_STATE);
  // フォームを描く
  return (
    <form action={formAction}>
      {/* ラベルと入力を対応させる (§7) */}
      <label htmlFor="token">{UI_TEXT.loginTokenLabel}</label>
      <input
        id="token"
        name="token"
        type="password"
        // 貼り付けるだけなので補完や自動大文字化を止める
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        // 入力が必須であることを支援技術にも伝える
        required
        // エラーがあるときは入力と結び付けて読み上げさせる
        aria-invalid={state.error !== null}
        aria-describedby={state.error === null ? undefined : 'login-error'}
      />
      {/* 送信中は二重送信を防ぐ */}
      <button type="submit" disabled={pending}>
        {UI_TEXT.loginSubmit}
      </button>
      {/* エラーは「即時に読み上げてほしい変化」なので aria-live を限定して付ける (§7) */}
      <p id="login-error" className="error" role="alert" aria-live="polite">
        {state.error}
      </p>
    </form>
  );
}
