// インシデント一覧（Step5）。ガードレールの発火を新しい順ではなく**記録順**に並べて出す。
//
// 既定は未解決だけ（ダッシュボードの「未解決インシデント」から飛んでくる先）。
// **件数には必ず上限を置く**（§8）。続きはカーソルで辿る。
import type { Metadata } from 'next';
import Link from 'next/link';
import { getRepos } from '@/data';
import { IncidentStatus, Role } from '@/domain/types';
import {
  AGENTS_PATH,
  APP_NAME,
  INCIDENTS_PATH,
  INCIDENT_STATUS_LABELS,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  UI_TEXT,
} from '@/lib/constants';
import { csrfTokenFor } from '@/lib/csrf';
import { RESULT_INCIDENT_RESOLVED, RESULT_QUERY_NAME } from '@/lib/dashboard/form';
import { resolveDashboardCursor } from '@/lib/dashboard/paging';
import {
  INCIDENT_VIEW_ALL,
  INCIDENT_VIEW_OPEN,
  resolveIncidentView,
} from '@/lib/dashboard/incident-view';
import { requireSession } from '@/lib/session-server';
import { ResolveIncidentForm } from './resolve-form';

// ブラウザのタブに出す題名
export const metadata: Metadata = {
  title: `${UI_TEXT.incidentsTitle} | ${APP_NAME}`,
};

export default async function IncidentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; cursor?: string; result?: string }>;
}) {
  // 未ログインならここで /login へ送られる
  const { principal, token } = await requireSession();
  // クエリを読む（Next.js 16 では searchParams も非同期）
  const query = await searchParams;
  // 表示条件とページ送りの位置を決める（読めない値は既定へ倒し、旗を立てる）
  const view = resolveIncidentView(query.status);
  const paging = resolveDashboardCursor(query.cursor);
  // データ層を取り、**認証情報から取り出したテナント**だけを引く（ADR-0002）
  const repos = await getRepos();
  const page = await repos.incidents.list(
    principal.tenantId,
    { limit: PAGE_LIMIT_DEFAULT, cursor: paging.cursor },
    { status: view.status },
  );
  // **エージェント名は 1 回のまとめ取得で引く**（行ごとに引くと N+1。§8）。
  // 上限を超える数のエージェントを持つテナントでは名前が引けない行が出るので、
  // そのときは id を出す（名前が引けないことを隠さない）
  const agents = await repos.agents.list(principal.tenantId, { limit: PAGE_LIMIT_MAX });
  const agentNames = new Map(agents.items.map((agent) => [agent.id, agent.name]));
  // 解決を操作できるのは admin だけ（表示の出し分けだけに使う。判定は Server Action 側）
  const canResolve = principal.user.role === Role.admin;
  // このセッション専用の CSRF トークンを導く（素のセッショントークンは画面へ出さない）
  const csrfToken = csrfTokenFor(token);
  // 画面を描く
  return (
    <>
      <h1>{UI_TEXT.incidentsTitle}</h1>
      {/* 直前の操作の結果（解決した行は一覧から消えるので、行の中には文言を残せない）。
          知らない値は何も出さない（印として扱わない） */}
      {query[RESULT_QUERY_NAME] === RESULT_INCIDENT_RESOLVED ? (
        <p role="status">{UI_TEXT.incidentResolved}</p>
      ) : null}
      {/* 表示条件の切り替え。副作用が無いのでリンク（GET）で正しい */}
      <p>
        {view.showAll ? (
          <Link href={`${INCIDENTS_PATH}?status=${INCIDENT_VIEW_OPEN}`}>
            {UI_TEXT.incidentsViewOpen}
          </Link>
        ) : (
          <Link href={`${INCIDENTS_PATH}?status=${INCIDENT_VIEW_ALL}`}>
            {UI_TEXT.incidentsViewAll}
          </Link>
        )}
      </p>
      {/* **採用しなかった指定は必ず伝える**（§7 色だけに意味を持たせない） */}
      {view.ignoredInput ? (
        <p className="error" role="status">
          {view.ignoredReason}
        </p>
      ) : null}
      {paging.ignoredInput ? (
        <p className="error" role="status">
          {paging.ignoredReason}
        </p>
      ) : null}
      {/* 1 件も無いときは空の表を出さずに理由を書く（条件によって文言を変える） */}
      {page.items.length === 0 ? (
        <p>{view.showAll ? UI_TEXT.incidentsEmptyAll : UI_TEXT.incidentsEmptyOpen}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">{UI_TEXT.columnOccurredAt}</th>
              <th scope="col">{UI_TEXT.columnAgent}</th>
              <th scope="col">{UI_TEXT.columnSummary}</th>
              <th scope="col">{UI_TEXT.columnStatus}</th>
              <th scope="col">{UI_TEXT.columnResolvedAt}</th>
              {/* 操作列は操作できる役割にだけ出す */}
              {canResolve ? <th scope="col">{UI_TEXT.agentDetailOperations}</th> : null}
            </tr>
          </thead>
          <tbody>
            {page.items.map((incident) => (
              <tr key={incident.id}>
                {/* 行の見出しは発火日時。ISO 8601 で出す（ロケール差で読み方が変わらない） */}
                <th scope="row">{incident.createdAt.toISOString()}</th>
                {/* エージェントは詳細へのリンク。名前が引けなければ id を出す */}
                <td>
                  <Link href={`${AGENTS_PATH}/${incident.agentId}`}>
                    {agentNames.get(incident.agentId) ?? incident.agentId}
                  </Link>
                </td>
                {/* 理由は保存された要約文をそのまま出す（文言は guardrail/summary.ts が正本） */}
                <td>{incident.summary}</td>
                {/* 状態は日本語ラベル。未解決は色に加えて太字でも分かる（§7） */}
                <td
                  className={incident.status === IncidentStatus.open ? 'state-danger' : undefined}
                >
                  {INCIDENT_STATUS_LABELS[incident.status]}
                </td>
                {/* 解決日時。未解決なら記号を出す（空欄だと読み込み失敗に見える） */}
                <td>
                  {incident.resolvedAt === null
                    ? UI_TEXT.notMeasured
                    : incident.resolvedAt.toISOString()}
                </td>
                {/* 未解決のものだけに解決ボタンを出す（押しても何も起きない操作を並べない） */}
                {canResolve ? (
                  <td>
                    {incident.status === IncidentStatus.open ? (
                      <ResolveIncidentForm incidentId={incident.id} csrfToken={csrfToken} />
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {/* 続きがあるときだけ次ページへのリンクを出す（表示条件も引き継ぐ） */}
      {page.nextCursor === undefined ? null : (
        <p>
          <Link
            href={`${INCIDENTS_PATH}?status=${view.showAll ? INCIDENT_VIEW_ALL : INCIDENT_VIEW_OPEN}&cursor=${encodeURIComponent(page.nextCursor)}`}
          >
            {UI_TEXT.nextPage}
          </Link>
        </p>
      )}
    </>
  );
}
