// ダッシュボード (Step5) が表示する数値を組み立てる**唯一の場所**。
//
// 画面・CSV のダウンロード・突合テストがすべてここを通る (§6 DRY)。写しを作ると
// 「画面には出ているのに CSV では違う」「テストは通るのに画面が違う」が起きる。
// 受け入れ基準「表示データと DB 集計の突合テスト一致 100%」はこの 1 本を突き合わせて確かめる。
import type { DailyUsageTotal, Repositories } from '@/data';
import { worstQualityScore } from '@/domain/guardrail/rule';
import { IncidentStatus } from '@/domain/types';
import { uptimeRate } from '@/domain/uptime';
import type { UsageWindow } from '@/domain/usage-window';
import { DASHBOARD_OPEN_INCIDENTS_MAX } from '@/lib/constants';

// 品質カードに出す 1 件分 (直近の採点が成立した評価実行)
export interface DashboardQuality {
  // 3 観点のうち最も悪い値 (向きをそろえた後)。測れていなければ null
  score: number | null;
  // どのエージェントの実行か (画面がリンクを張る)
  agentId: string;
  // いつ走った実行か
  ranAt: Date;
}

// ダッシュボードに出す 1 画面分の数値
export interface DashboardSummary {
  // 集計した期間 (画面の見出しと CSV のファイル名が使う)
  window: UsageWindow;
  // 期間内の中継回数 (失敗も含む)
  requests: number;
  // そのうち失敗した回数
  errorRequests: number;
  // 稼働率 (0〜1)。呼び出しが 0 件なら null
  uptimeRate: number | null;
  // 期間内の料金の合計 (マイクロ USD)
  costMicroUsd: bigint;
  // 直近の評価実行から読んだ品質。期間内に採点が成立した実行が無ければ null
  quality: DashboardQuality | null;
  // 未解決のインシデントの件数 (上限まで数える。下記の注記を参照)
  openIncidents: number;
  // 未解決のインシデントが上限より多いか (画面が「以上」と表示するため)
  openIncidentsReachedLimit: boolean;
  // 日ごとの明細 (画面の表と CSV が同じ配列を使う)
  daily: DailyUsageTotal[];
}

/**
 * 1 テナント分のダッシュボードの数値をまとめて取る。
 *
 * **`tenantId` は呼び出し側が認証情報から取り出した値を渡す**（画面が勝手に決めない。ADR-0002）。
 * ここから下のすべての問い合わせにその値が入る。
 *
 * **問い合わせは 3 本だけ**（日次集計・直近の評価実行・未解決インシデント）。
 * エージェント台数ぶんのループを作らない（§8 の N+1 回避）。
 */
export async function loadDashboardSummary(
  repos: Repositories,
  tenantId: string,
  window: UsageWindow,
): Promise<DashboardSummary> {
  // 日ごとの明細を取る (稼働率とコストはこの配列から足し上げる)
  const daily = await repos.usageEvents.dailyTotals(tenantId, {
    start: window.start,
    endExclusive: window.endExclusive,
  });
  // 期間内の最新の「採点が成立した」評価実行 (テナント全体から 1 件)
  const latestRun = await repos.evaluations.findLatestCompletedRun(
    tenantId,
    null,
    window.start,
    window.endExclusive,
  );
  // 未解決のインシデントを数える。**一覧の上限までしか数えない** —
  // 件数だけを知るための無制限の取得は §8 / §9 が禁じているので、上限 + 1 件まで引いて
  // 「上限を超えているか」を別に返す (画面は「50 件以上」と表示できる)
  const openIncidents = await repos.incidents.list(
    tenantId,
    { limit: DASHBOARD_OPEN_INCIDENTS_MAX + 1 },
    { status: IncidentStatus.open },
  );
  // 上限を超えていたかどうか (超えていれば表示を「以上」にする)
  const reachedLimit = openIncidents.items.length > DASHBOARD_OPEN_INCIDENTS_MAX;
  // 回数と料金を日次の明細から足し上げる (集計の出どころを 1 つにする)
  const requests = daily.reduce((total, row) => total + row.requests, 0);
  const errorRequests = daily.reduce((total, row) => total + row.errorRequests, 0);
  const costMicroUsd = daily.reduce((total, row) => total + row.costMicroUsd, 0n);
  // 画面が使う形にまとめて返す
  return {
    window,
    requests,
    errorRequests,
    // 稼働率の計算はドメインの純粋関数に任せる (0 件は null)
    uptimeRate: uptimeRate(requests, errorRequests),
    costMicroUsd,
    // 品質は 3 観点の最悪値。**自動停止の判定と同じ関数**を通す
    // (別に計算すると「画面は健全と言うのに停止した」という説明できない状態が起きる)
    quality:
      latestRun === null
        ? null
        : {
            score: worstQualityScore(latestRun),
            agentId: latestRun.agentId,
            ranAt: latestRun.createdAt,
          },
    // 上限より多い場合は上限の値を返す (画面は reachedLimit を見て「以上」を付ける)
    openIncidents: Math.min(openIncidents.items.length, DASHBOARD_OPEN_INCIDENTS_MAX),
    openIncidentsReachedLimit: reachedLimit,
    daily,
  };
}
