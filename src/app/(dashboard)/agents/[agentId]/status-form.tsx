// 停止 / 復帰のボタン（Step5）。**結果の表示だけのためにクライアント側で動く。**
//
// Server Action は `useActionState` が呼ぶので、押したあとの成否をページ遷移なしに
// 同じ画面へ出せる（失敗の理由が見えないまま押し直す、を避ける）。
// **判定は 1 つもここに無い** — 権限・CSRF・テナントの絞り込みはすべてサーバ側（§9）。
'use client';

import { useActionState } from 'react';
import { CSRF_FIELD_NAME } from '@/lib/csrf';
import {
  DASHBOARD_ACTION_INITIAL,
  TARGET_ID_FIELD_NAME,
  type DashboardActionState,
} from '@/lib/dashboard/form';
import { resumeAgent, stopAgent } from '../actions';

// どちらの操作かを表す値（画面から渡す）
export type AgentStatusActionKind = 'stop' | 'resume';

// 種類から Server Action への対応。**表で持つ**ので、種類を足したら typecheck が落ちる
const ACTION_BY_KIND: Readonly<
  Record<
    AgentStatusActionKind,
    (previous: DashboardActionState, formData: FormData) => Promise<DashboardActionState>
  >
> = {
  // 停止
  stop: stopAgent,
  // 復帰
  resume: resumeAgent,
};

interface AgentStatusFormProps {
  // 操作対象のエージェント id
  agentId: string;
  // このセッションから導いた CSRF トークン（サーバ側で同じ計算をして比べる）
  csrfToken: string;
  // 停止か復帰か
  kind: AgentStatusActionKind;
  // ボタンの文言（文言は constants.ts が持つ）
  label: string;
}

export function AgentStatusForm({ agentId, csrfToken, kind, label }: AgentStatusFormProps) {
  // 対応する Server Action を選び、その結果を状態として受け取る
  const [state, formAction, pending] = useActionState(
    ACTION_BY_KIND[kind],
    DASHBOARD_ACTION_INITIAL,
  );
  // フォームを描く
  return (
    <form action={formAction}>
      {/* 操作対象。**サーバ側でも資源 id の形とテナントを確かめる**ので、ここは受け渡しだけ */}
      <input type="hidden" name={TARGET_ID_FIELD_NAME} value={agentId} />
      {/* CSRF トークン（2 枚重ねの 2 枚目） */}
      <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
      {/* 送信中は二重送信を防ぐために押せなくする */}
      <button type="submit" disabled={pending}>
        {label}
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
