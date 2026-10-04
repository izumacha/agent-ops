// インシデントを解決済みにする Server Action（Step5 / ADR-0011）。
//
// **admin ロール限定**（`POST /incidents/{id}/resolve` と同じ重さの操作。UC-09）。守りの順序は
// エージェントの停止／復帰と同じ「他サイトからの送信を断る → セッション → CSRF → ロール →
// テナントで絞って更新 → 監査ログ」で、部品もすべて API 経路と共有する。
//
// **エージェントの復帰は別操作のまま**（画面でも 2 つに分ける）。「原因に対処した」と
// 「また動かしてよい」は別の判断で、まとめると片方だけ行いたい運用ができなくなる。
'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getRepos } from '@/data';
import { AuditAction, AuditTargetType } from '@/domain/audit/action';
import { isResourceId } from '@/domain/resource-id';
import type { UserPrincipal } from '@/lib/api/auth';
import { ApiError } from '@/lib/api/errors';
import { requireAdminRole } from '@/lib/api/guard';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { assertAuditConfigured, recordAudit } from '@/lib/audit/record';
import { DASHBOARD_PATH, INCIDENTS_PATH, LOGIN_PATH, UI_TEXT } from '@/lib/constants';
import { CSRF_FIELD_NAME, csrfTokenMatches } from '@/lib/csrf';
import {
  RESULT_INCIDENT_RESOLVED,
  RESULT_QUERY_NAME,
  TARGET_ID_FIELD_NAME,
  type DashboardActionState,
} from '@/lib/dashboard/form';
import { currentSession, isSameOriginAction } from '@/lib/session-server';

/**
 * インシデントを解決済みにする。
 *
 * **解決は 1 度だけ成功する**（条件付き更新で「開いているものだけ」を閉じる）ので、
 * 2 度押しは「すでに解決済み」と返る — 監査ログに同じ操作を二重に残さない。
 */
export async function resolveIncident(
  _previous: DashboardActionState,
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
  // 認可は API と同じガードで行う（admin ロールそのものを比べる唯一の用途）
  let actor: UserPrincipal;
  try {
    // admin ロールであること
    actor = requireAdminRole(session.principal);
  } catch (error) {
    // 権限不足だけを画面の文言に写し、それ以外は握り潰さず投げ直す（§6）
    if (error instanceof ApiError && error.status === HTTP_STATUS.FORBIDDEN) {
      return { error: UI_TEXT.actionForbidden, message: null };
    }
    throw error;
  }
  // **状態を変える前に「監査ログを書ける状態か」を確かめる** — 変えてから記録に失敗すると、
  // 解決済みなのに記録が無く、再試行は「すでに解決済み」で永久に成功しない
  assertAuditConfigured();
  // データ層を取る
  const repos = await getRepos();
  // **自テナント内だけで解決する**（他テナントの id は 'not_found' が返る。ADR-0002）
  const result = await repos.incidents.resolve(actor.tenantId, submittedId);
  // 見つからなければ「見つかりません」と返す（他テナントに存在することは漏らさない）
  if (result === 'not_found') return { error: UI_TEXT.incidentNotFound, message: null };
  // すでに解決済みなら、記録を増やさずそのことだけ伝える
  if (result === 'already_resolved') {
    return { error: UI_TEXT.incidentAlreadyResolved, message: null };
  }
  // 解決後の行を読み直す（更新は条件付きなので行を返さない）
  const incident = await repos.incidents.findById(actor.tenantId, submittedId);
  // 直後に消えていれば「見つかりません」（テナント削除と同時に呼ばれた場合）
  if (incident === null) return { error: UI_TEXT.incidentNotFound, message: null };
  // 誰がいつ何を解決したかを記録する（API 経路と同じ操作名・同じ payload）
  await recordAudit(repos, {
    tenantId: actor.tenantId,
    actorId: actor.user.id,
    action: AuditAction.incident_resolved,
    targetType: AuditTargetType.incident,
    targetId: incident.id,
    payload: { agentId: incident.agentId, ruleId: incident.ruleId },
  });
  // 一覧と、未解決件数を出しているダッシュボードの表示を作り直す
  revalidatePath(INCIDENTS_PATH);
  revalidatePath(DASHBOARD_PATH);
  // **成功したら印を付けて同じ画面へ送る**（この行より下は実行されない）。
  // 解決した行は既定の表示（未解決のみ）から消えるので、行の中のフォームに文言を返しても
  // 一緒に消えてしまう — サーバ側で描ける形に移す（理由は RESULT_QUERY_NAME）。
  // 表示条件は既定へ戻る（解決した直後に見たいのは残っている未解決なので、そちらへ寄せる）
  redirect(`${INCIDENTS_PATH}?${RESULT_QUERY_NAME}=${RESULT_INCIDENT_RESOLVED}`);
}
