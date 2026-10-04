// エージェント一覧（Step5）。登録済みのエージェントと稼働状態を出す。
//
// **件数には必ず上限を置く**（§8）。1 ページは API と同じ既定件数で、続きはカーソルで辿る
// （一覧の順序とカーソルの形は `src/data/page.ts` が正本）。
import type { Metadata } from 'next';
import Link from 'next/link';
import { getRepos } from '@/data';
import { formatMicroUsdAsUsd } from '@/domain/money';
import {
  AGENTS_PATH,
  AGENT_STATUS_LABELS,
  APP_NAME,
  PAGE_LIMIT_DEFAULT,
  UI_TEXT,
} from '@/lib/constants';
import { resolveDashboardCursor } from '@/lib/dashboard/paging';
import { requireSession } from '@/lib/session-server';
import { AgentStatus } from '@/domain/types';

// ブラウザのタブに出す題名
export const metadata: Metadata = {
  title: `${UI_TEXT.agentsTitle} | ${APP_NAME}`,
};

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  // 未ログインならここで /login へ送られる
  const { principal } = await requireSession();
  // クエリを読む（Next.js 16 では searchParams も非同期）
  const query = await searchParams;
  // ページ送りの位置を決める（読めない値は先頭へ倒し、旗を立てる）
  const paging = resolveDashboardCursor(query.cursor);
  // データ層を取り、**認証情報から取り出したテナント**だけを引く（ADR-0002）
  const repos = await getRepos();
  const page = await repos.agents.list(principal.tenantId, {
    limit: PAGE_LIMIT_DEFAULT,
    cursor: paging.cursor,
  });
  // 画面を描く
  return (
    <>
      <h1>{UI_TEXT.agentsTitle}</h1>
      {/* **採用しなかった指定は必ず伝える**（§7 色だけに意味を持たせない） */}
      {paging.ignoredInput ? (
        <p className="error" role="status">
          {paging.ignoredReason}
        </p>
      ) : null}
      {/* 1 件も無いときは空の表を出さずに理由を書く */}
      {page.items.length === 0 ? (
        <p>{UI_TEXT.agentsEmpty}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">{UI_TEXT.columnAgentName}</th>
              <th scope="col">{UI_TEXT.columnProvider}</th>
              <th scope="col">{UI_TEXT.columnModel}</th>
              <th scope="col">{UI_TEXT.columnStatus}</th>
              <th scope="col" className="number">
                {UI_TEXT.columnBudget}
              </th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((agent) => (
              <tr key={agent.id}>
                {/* 行の見出しは名前。詳細へのリンクにする（表の読み上げで行が特定できる。§7） */}
                <th scope="row">
                  <Link href={`${AGENTS_PATH}/${agent.id}`}>{agent.name}</Link>
                </th>
                <td>{agent.provider}</td>
                <td>{agent.model}</td>
                {/* 状態は日本語ラベルで出し、停止中は色に加えて文字でも分かる（§7） */}
                <td className={agent.status === AgentStatus.active ? undefined : 'state-danger'}>
                  {AGENT_STATUS_LABELS[agent.status]}
                </td>
                {/* 予算は BigInt のまま整形する。未設定は「未設定」と書く（0 と書かない） */}
                <td className="number">
                  {agent.budgetMicroUsd === null
                    ? UI_TEXT.agentDetailBudgetUnset
                    : `$${formatMicroUsdAsUsd(agent.budgetMicroUsd)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {/* 続きがあるときだけ次ページへのリンクを出す */}
      {page.nextCursor === undefined ? null : (
        <p>
          <Link href={`${AGENTS_PATH}?cursor=${encodeURIComponent(page.nextCursor)}`}>
            {UI_TEXT.nextPage}
          </Link>
        </p>
      )}
    </>
  );
}
