// ダッシュボード本体（Step5）。コスト・品質・稼働率・未解決インシデントと日次の内訳を出す。
//
// **数値は `loadDashboardSummary` が組み立てたものだけを描く。** ここで足し算や割り算をしない
// （画面と CSV と突合テストが同じ 1 本を通る形を崩さない。§6 DRY）。
import type { Metadata } from 'next';
import Link from 'next/link';
import { getRepos } from '@/data';
import { formatMicroUsdAsUsd } from '@/domain/money';
import { APP_NAME, DAILY_REPORT_PATH, INCIDENTS_PATH, UI_TEXT } from '@/lib/constants';
import { loadDashboardSummary } from '@/lib/dashboard/summary';
import { resolveDashboardRange } from '@/lib/dashboard/range';
import { uptimeRate } from '@/domain/uptime';
import { requireSession } from '@/lib/session-server';

// ブラウザのタブに出す題名
export const metadata: Metadata = {
  title: `${UI_TEXT.dashboardTitle} | ${APP_NAME}`,
};

// 割合を百分率の文字列にする。**測れていないときは「—」**（0% と書かない）
function formatRate(rate: number | null): string {
  // null は「測れていない」ので記号で表す
  if (rate === null) return UI_TEXT.notMeasured;
  // 小数 1 桁の百分率にする（表示の桁はここで決める。集計側は丸めない）
  return `${(rate * 100).toFixed(1)}%`;
}

// 品質スコアを表示用の文字列にする（0〜1 を小数 2 桁で出す）
function formatScore(score: number | null): string {
  // 採点できていなければ記号で表す
  if (score === null) return UI_TEXT.notMeasured;
  return score.toFixed(2);
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  // 未ログインならここで /login へ送られる
  const { principal } = await requireSession();
  // クエリを読む（Next.js 16 では searchParams も非同期）
  const query = await searchParams;
  // 期間を決める（読めない指定は既定へ倒し、旗を立てる）
  const range = resolveDashboardRange(query.from, query.to);
  // データ層を取り、**認証情報から取り出したテナント**の数値を引く（ADR-0002）
  const repos = await getRepos();
  const summary = await loadDashboardSummary(repos, principal.tenantId, range.window);
  // 画面を描く
  return (
    <>
      <h1>{UI_TEXT.dashboardTitle}</h1>
      {/* 期間の指定。GET のフォームなので URL を共有できる（副作用が無いので GET で正しい） */}
      <form method="get">
        <label htmlFor="from">{UI_TEXT.rangeFrom}</label>
        <input id="from" name="from" type="date" defaultValue={range.fromText} />
        <label htmlFor="to">{UI_TEXT.rangeTo}</label>
        <input id="to" name="to" type="date" defaultValue={range.toText} />
        <button type="submit">{UI_TEXT.rangeApply}</button>
      </form>
      {/* **採用しなかった指定は必ず伝える**（色だけでなく文字で理由を書く。§7） */}
      {range.ignoredInput ? (
        <p className="error" role="status">
          {range.ignoredReason}
        </p>
      ) : null}
      {/* 数値カード。dl で「項目名と値」の対応を支援技術へ伝える */}
      <dl className="cards">
        <div className="card">
          <dt>{UI_TEXT.cardCost}</dt>
          {/* 金額は BigInt のまま整形する（Number を挟まない） */}
          <dd>${formatMicroUsdAsUsd(summary.costMicroUsd)}</dd>
        </div>
        <div className="card">
          <dt>{UI_TEXT.cardRequests}</dt>
          <dd>{summary.requests.toLocaleString('ja-JP')}</dd>
        </div>
        <div className="card">
          <dt>{UI_TEXT.cardUptime}</dt>
          <dd>{formatRate(summary.uptimeRate)}</dd>
        </div>
        <div className="card">
          <dt>{UI_TEXT.cardQuality}</dt>
          <dd>{formatScore(summary.quality?.score ?? null)}</dd>
        </div>
        <div className="card">
          <dt>{UI_TEXT.cardOpenIncidents}</dt>
          <dd>
            {/* 上限まで数えた場合は「以上」を付ける（無制限に数えないため） */}
            <Link href={INCIDENTS_PATH}>
              {summary.openIncidents}
              {summary.openIncidentsReachedLimit ? ' 件以上' : ' 件'}
            </Link>
          </dd>
        </div>
      </dl>
      <h2>{UI_TEXT.dailyTableTitle}</h2>
      {/* CSV は同じ期間・同じ集計関数から作る */}
      <p>
        <Link href={`${DAILY_REPORT_PATH}?from=${range.fromText}&to=${range.toText}`}>
          {UI_TEXT.dailyReportLink}
        </Link>
      </p>
      {/* 記録が無い期間は表を出さずに理由を書く（空の表だけだと壊れたように見える） */}
      {summary.daily.length === 0 ? (
        <p>{UI_TEXT.noData}</p>
      ) : (
        <table>
          <caption>
            {range.fromText} 〜 {range.toText}
          </caption>
          <thead>
            <tr>
              <th scope="col">{UI_TEXT.columnDay}</th>
              <th scope="col" className="number">
                {UI_TEXT.columnRequests}
              </th>
              <th scope="col" className="number">
                {UI_TEXT.columnErrors}
              </th>
              <th scope="col" className="number">
                {UI_TEXT.columnUptime}
              </th>
              <th scope="col" className="number">
                {UI_TEXT.columnCost}
              </th>
            </tr>
          </thead>
          <tbody>
            {summary.daily.map((row) => (
              <tr key={row.day}>
                {/* 行の見出しは日付（表の読み上げで列と行が対応する。§7） */}
                <th scope="row">{row.day}</th>
                <td className="number">{row.requests.toLocaleString('ja-JP')}</td>
                <td className="number">{row.errorRequests.toLocaleString('ja-JP')}</td>
                {/* 日ごとの稼働率も同じドメイン関数で出す（画面で割り算しない） */}
                <td className="number">
                  {formatRate(uptimeRate(row.requests, row.errorRequests))}
                </td>
                <td className="number">${formatMicroUsdAsUsd(row.costMicroUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
