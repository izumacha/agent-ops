// 停止 / 復帰のボタン（Step5）。**結果の表示だけのためにクライアント側で動く。**
//
// Server Action は `useActionState` が呼ぶので、押したあとの成否をページ遷移なしに
// 同じ画面へ出せる（失敗の理由が見えないまま押し直す、を避ける）。
// **判定は 1 つもここに無い** — 権限・CSRF・テナントの絞り込みはすべてサーバ側（§9）。
//
// **呼ぶ Server Action は常に 1 つ**（停止と復帰で切り替えない）— 切り替えると、押した直後に
// ボタンが入れ替わる場面で `useActionState` の状態が捨てられ、成功の文言が一度も見えない（実測）。
'use client';

import { useActionState } from 'react';
import { AgentStatusIntent } from '@/domain/agent-status';
import { UI_TEXT } from '@/lib/constants';
import { CSRF_FIELD_NAME } from '@/lib/csrf';
import {
  DASHBOARD_ACTION_INITIAL,
  INTENT_FIELD_NAME,
  TARGET_ID_FIELD_NAME,
} from '@/lib/dashboard/form';
import { changeAgentStatus } from '../actions';

// 操作の意図からボタンの文言への対応（文言は constants.ts が持つ。ここは対応表だけ）
const LABEL_BY_INTENT: Readonly<Record<AgentStatusIntent, string>> = {
  // 止める
  [AgentStatusIntent.stop]: UI_TEXT.agentStop,
  // 戻す
  [AgentStatusIntent.resume]: UI_TEXT.agentResume,
};

interface AgentStatusFormProps {
  // 操作対象のエージェント id
  agentId: string;
  // このセッションから導いた CSRF トークン（サーバ側で同じ計算をして比べる）
  csrfToken: string;
  // 停止か復帰か（画面は現在の状態から決める）
  intent: AgentStatusIntent;
}

export function AgentStatusForm({ agentId, csrfToken, intent }: AgentStatusFormProps) {
  // Server Action の結果を状態として受け取る（**関数は常に同じ**なので状態が残る）
  const [state, formAction, pending] = useActionState(changeAgentStatus, DASHBOARD_ACTION_INITIAL);
  // フォームを描く
  return (
    <form action={formAction}>
      {/* 操作対象。**サーバ側でも資源 id の形とテナントを確かめる**ので、ここは受け渡しだけ */}
      <input type="hidden" name={TARGET_ID_FIELD_NAME} value={agentId} />
      {/* どちらの操作か。**サーバ側で表と突き合わせる**ので、知らない値は断られる */}
      <input type="hidden" name={INTENT_FIELD_NAME} value={intent} />
      {/* CSRF トークン（2 枚重ねの 2 枚目） */}
      <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
      {/* 送信中は二重送信を防ぐために押せなくする */}
      <button type="submit" disabled={pending}>
        {LABEL_BY_INTENT[intent]}
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
