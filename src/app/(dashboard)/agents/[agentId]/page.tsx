// エージェント詳細（Step5）。登録内容と稼働状態を出し、停止 / 復帰を操作する。
//
// **操作できるかどうかの判定は Server Action 側にある。** ここでボタンを出し分けるのは
// 「押しても断られるボタンを並べない」ための表示上の配慮で、認可そのものではない（§9）。
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getRepos } from '@/data';
import { formatMicroUsdAsUsd } from '@/domain/money';
import { AgentStatusIntent } from '@/domain/agent-status';
import { canPerform } from '@/domain/rbac';
import { isResourceId } from '@/domain/resource-id';
import { AgentStatus } from '@/domain/types';
import { AGENTS_PATH, AGENT_STATUS_LABELS, APP_NAME, UI_TEXT } from '@/lib/constants';
import { csrfTokenFor } from '@/lib/csrf';
import { formatUtcMinute } from '@/lib/dashboard/datetime';
import { requireSession } from '@/lib/session-server';
import { AgentStatusForm } from './status-form';

// ブラウザのタブに出す題名（個々の名前は入れない。一覧と同じ見出しで十分）
export const metadata: Metadata = {
  title: `${UI_TEXT.agentsTitle} | ${APP_NAME}`,
};

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  // 未ログインならここで /login へ送られる
  const { principal, token } = await requireSession();
  // パスの値を読む（Next.js 16 では params も非同期）
  const { agentId } = await params;
  // **資源 id の形でなければ 404**（形の定義は src/domain/resource-id.ts の 1 か所。
  // 素通しすると PostgreSQL が拒否して 500 になる。API 側の route() と同じ理由）
  if (!isResourceId(agentId)) notFound();
  // データ層を取り、**認証情報から取り出したテナント**だけを引く（ADR-0002）
  const repos = await getRepos();
  const agent = await repos.agents.findById(principal.tenantId, agentId);
  // 他テナントの id も「無い」として 404 にする（403 だと存在が漏れる）
  if (agent === null) notFound();
  // 停止・復帰を操作できる役割か（表示の出し分けだけに使う）
  const canOperate = canPerform(principal.user.role, 'stop');
  // このセッション専用の CSRF トークンを導く（素のセッショントークンは画面へ出さない）
  const csrfToken = csrfTokenFor(token);
  // 画面を描く
  return (
    <>
      <h1>{agent.name}</h1>
      {/* 登録内容。dl で「項目名と値」の対応を支援技術へ伝える */}
      <dl>
        <dt>{UI_TEXT.columnStatus}</dt>
        {/* 状態は日本語ラベル。稼働中以外は色に加えて太字で分かる（§7） */}
        <dd className={agent.status === AgentStatus.active ? undefined : 'state-danger'}>
          {AGENT_STATUS_LABELS[agent.status]}
        </dd>
        <dt>{UI_TEXT.columnProvider}</dt>
        <dd>{agent.provider}</dd>
        <dt>{UI_TEXT.columnModel}</dt>
        <dd>{agent.model}</dd>
        <dt>{UI_TEXT.columnBudget}</dt>
        {/* 予算は BigInt のまま整形し、未設定は「未設定」と書く（0 と書かない） */}
        <dd>
          {agent.budgetMicroUsd === null
            ? UI_TEXT.agentDetailBudgetUnset
            : `$${formatMicroUsdAsUsd(agent.budgetMicroUsd)}`}
        </dd>
        <dt>{UI_TEXT.agentDetailDescription}</dt>
        {/* 説明が無い場合も項目を落とさず「説明なし」と書く（空欄だと読み込み失敗に見える） */}
        <dd>{agent.description ?? UI_TEXT.agentDetailNoDescription}</dd>
        <dt>{UI_TEXT.agentDetailCreatedAt}</dt>
        {/* 日時は分まで（UTC）。タイムゾーンは項目名が伝える */}
        <dd>{formatUtcMinute(agent.createdAt)}</dd>
      </dl>
      {/* 操作できる役割にだけボタンを見せる（判定の本体は Server Action 側） */}
      {canOperate ? (
        <>
          <h2>{UI_TEXT.agentDetailOperations}</h2>
          {/* 稼働中なら止める、止まっているなら戻す（押しても何も起きない操作を並べない）。
              **フォームは 1 つだけ置き、種類だけを切り替える** — 分岐で 2 つ並べると、
              操作のあとに木の別の位置へ切り替わってフォームの状態が捨てられ、
              「停止しました。」の文言が一度も見えないまま状態だけが変わる（実測） */}
          <AgentStatusForm
            agentId={agent.id}
            csrfToken={csrfToken}
            intent={
              agent.status === AgentStatus.active
                ? AgentStatusIntent.stop
                : AgentStatusIntent.resume
            }
          />
        </>
      ) : null}
      {/* 一覧へ戻る導線 */}
      <p>
        <Link href={AGENTS_PATH}>{UI_TEXT.backToAgents}</Link>
      </p>
    </>
  );
}
