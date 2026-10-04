// エージェントの停止 / 復帰の Server Action（Step5 / ADR-0011）。
//
// **認可はここで強制する。** レイアウトの `requireSession()` はルーティングの枝であって認可では
// ないので、UI にボタンを出さないことに頼らない（§9「UI を隠すだけに頼らない」）。
// 守りの順序は「他サイトからの送信を断る → セッション → CSRF → RBAC → テナントで絞って更新」。
//
// **API（`POST /agents/{id}/stop`・`/resume`）と同じ部品を通す** — 許可表（`requireAction`）・
// 状態の書き換え（`repos.agents.setStatus`）・監査ログ（`recordAudit`）・操作名の対応
// （`AGENT_STATUS_AUDIT_ACTION`）はすべて共有で、ここに書き下したものは 1 つも無い。
'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getRepos } from '@/data';
import { AGENT_STATUS_AUDIT_ACTION, type SettableAgentStatus } from '@/domain/agent-status';
import { AuditTargetType } from '@/domain/audit/action';
import { AgentStatus } from '@/domain/types';
import { isResourceId } from '@/domain/resource-id';
import type { UserPrincipal } from '@/lib/api/auth';
import { ApiError } from '@/lib/api/errors';
import { requireAction } from '@/lib/api/guard';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { assertAuditConfigured, recordAudit } from '@/lib/audit/record';
import { AGENTS_PATH, LOGIN_PATH, UI_TEXT } from '@/lib/constants';
import { CSRF_FIELD_NAME, csrfTokenMatches } from '@/lib/csrf';
// **項目名と状態の型は別のファイルが持つ** — `'use server'` のファイルは async 関数以外を
// export できない（ビルドが落ちる）。画面・Server Action・テストで綴りを共有する
import { TARGET_ID_FIELD_NAME, type DashboardActionState } from '@/lib/dashboard/form';
import { currentSession, isSameOriginAction } from '@/lib/session-server';

// 状態変更が成功したときに出す文言。**表で持つ**ので、状態を足したら typecheck が落ちる
const SUCCESS_MESSAGE: Readonly<Record<SettableAgentStatus, string>> = {
  // 復帰させた
  [AgentStatus.active]: UI_TEXT.agentResumed,
  // 停止した
  [AgentStatus.stopped]: UI_TEXT.agentStopped,
};

/**
 * 指定した状態へ変える共通処理。`stopAgent` / `resumeAgent` の両方がここを通る。
 *
 * **失敗はすべて「状態を変えない」側に倒す**（§9 fail-closed）。理由は画面へ短い文言で返し、
 * 内部の詳細（例外の中身・他テナントに存在するかどうか）は出さない。
 */
async function changeAgentStatus(
  status: SettableAgentStatus,
  formData: FormData,
): Promise<DashboardActionState> {
  // 1 枚目: 他サイトのフォームからの送信を断る
  if (!(await isSameOriginAction())) return { error: UI_TEXT.actionRejected, message: null };
  // セッションを読む（素のトークンは CSRF トークンの導出にだけ使う）
  const session = await currentSession();
  // 未ログイン・失効していればログイン画面へ送る（この行より下は実行されない）
  if (session === null) redirect(LOGIN_PATH);
  // 2 枚目: フォームの CSRF トークンがこのセッションから導いた値と一致すること
  if (!csrfTokenMatches(session.token, formData.get(CSRF_FIELD_NAME))) {
    return { error: UI_TEXT.actionRejected, message: null };
  }
  // 操作対象の id を取り出す（FormData は File も返しうるので型で確かめる）
  const submittedId = formData.get(TARGET_ID_FIELD_NAME);
  // 資源 id の形でなければ断る（形の定義は src/domain/resource-id.ts の 1 か所）
  if (typeof submittedId !== 'string' || !isResourceId(submittedId)) {
    return { error: UI_TEXT.actionRejected, message: null };
  }
  // 認可は API と同じガードで行う（許可表は src/domain/rbac.ts が唯一の真実の源）
  let actor: UserPrincipal;
  try {
    // stop 権限（停止・復帰はどちらも「止める権限を持つ人」の操作。UC-09）
    actor = requireAction(session.principal, 'stop');
  } catch (error) {
    // 権限不足だけを画面の文言に写し、それ以外は握り潰さず投げ直す（§6）
    if (error instanceof ApiError && error.status === HTTP_STATUS.FORBIDDEN) {
      return { error: UI_TEXT.actionForbidden, message: null };
    }
    throw error;
  }
  // **状態を変える前に「監査ログを書ける状態か」を確かめる**（記録の無い変更を残さない）
  assertAuditConfigured();
  // データ層を取る
  const repos = await getRepos();
  // **自テナント内だけで状態を変える**（他テナントの id は null が返る。ADR-0002）
  const agent = await repos.agents.setStatus(actor.tenantId, submittedId, status);
  // 見つからなければ「見つかりません」と返す（他テナントに存在することは漏らさない）
  if (agent === null) return { error: UI_TEXT.agentNotFound, message: null };
  // 誰がいつ何を要求したかを記録する（API 経路と同じ操作名・同じ payload）
  await recordAudit(repos, {
    tenantId: actor.tenantId,
    actorId: actor.user.id,
    action: AGENT_STATUS_AUDIT_ACTION[status],
    targetType: AuditTargetType.agent,
    targetId: agent.id,
    // 変更後の状態だけを残す（機微情報を入れない）
    payload: { status: agent.status },
  });
  // 一覧と詳細の表示を作り直す（古い状態が残らないように）
  revalidatePath(AGENTS_PATH);
  revalidatePath(`${AGENTS_PATH}/${agent.id}`);
  // 成功の文言を返す
  return { error: null, message: SUCCESS_MESSAGE[status] };
}

/** エージェントを手動で停止する（stop 権限）。 */
export async function stopAgent(
  _previous: DashboardActionState,
  formData: FormData,
): Promise<DashboardActionState> {
  // 停止は status を stopped にする操作
  return changeAgentStatus(AgentStatus.stopped, formData);
}

/** エージェントを復帰させる（stop 権限。手動停止・自動停止のどちらからでも active へ戻す）。 */
export async function resumeAgent(
  _previous: DashboardActionState,
  formData: FormData,
): Promise<DashboardActionState> {
  // 復帰は status を active にする操作
  return changeAgentStatus(AgentStatus.active, formData);
}
