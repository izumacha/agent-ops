// 「解決済みにする」ボタン（Step5）。**結果の表示だけのためにクライアント側で動く。**
//
// **判定は 1 つもここに無い** — ロール・CSRF・テナントの絞り込みはすべてサーバ側（§9）。
'use client';

import { useActionState } from 'react';
import { UI_TEXT } from '@/lib/constants';
import { CSRF_FIELD_NAME } from '@/lib/csrf';
import { DASHBOARD_ACTION_INITIAL, TARGET_ID_FIELD_NAME } from '@/lib/dashboard/form';
import { resolveIncident } from './actions';

interface ResolveIncidentFormProps {
  // 操作対象のインシデント id
  incidentId: string;
  // このセッションから導いた CSRF トークン（サーバ側で同じ計算をして比べる）
  csrfToken: string;
}

export function ResolveIncidentForm({ incidentId, csrfToken }: ResolveIncidentFormProps) {
  // Server Action の結果を状態として受け取る
  const [state, formAction, pending] = useActionState(resolveIncident, DASHBOARD_ACTION_INITIAL);
  // フォームを描く
  return (
    <form action={formAction}>
      {/* 操作対象。**サーバ側でも資源 id の形とテナントを確かめる**ので、ここは受け渡しだけ */}
      <input type="hidden" name={TARGET_ID_FIELD_NAME} value={incidentId} />
      {/* CSRF トークン（2 枚重ねの 2 枚目） */}
      <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
      {/* 送信中は二重送信を防ぐために押せなくする */}
      <button type="submit" disabled={pending}>
        {UI_TEXT.incidentResolve}
      </button>
      {/* 失敗は色だけでなく文字で理由を出し、支援技術へも即時に伝える（§7） */}
      {state.error === null ? null : (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {/* 成功も文字で伝える（押したのに何も起きていないように見えるのを避ける） */}
      {state.message === null ? null : <p role="status">{state.message}</p>}
    </form>
  );
}
