// 日次レポートのダウンロード（Step5）。**画面と同じ集計関数から CSV を作る**。
//
// `src/app/api/v1/*` ではなく画面側に置くのは、ここが REST API ではなく
// 「ブラウザのセッションでダウンロードする画面の一部」だから（認証は Cookie、応答は CSV）。
// OpenAPI の契約（ADR-0003）は `/api/v1` の下だけを対象にする。
import { getRepos } from '@/data';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { buildDailyReportCsv, dailyReportFileName } from '@/lib/dashboard/csv';
import { resolveDashboardRange } from '@/lib/dashboard/range';
import { loadDashboardSummary } from '@/lib/dashboard/summary';
import { currentSession } from '@/lib/session-server';

export async function GET(request: Request): Promise<Response> {
  // **認証はここでも自分で確かめる**（レイアウトの認証は画面の枝で、このルートは通らない。§9）
  const session = await currentSession();
  // 未ログインなら 401（画面と違いリダイレクトしない。ファイルの取得なので遷移先が無い）
  if (session === null) {
    return new Response('ログインが必要です。\n', {
      status: HTTP_STATUS.UNAUTHORIZED,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  // クエリから期間を決める（画面と同じ関数なので解釈が割れない）
  const url = new URL(request.url);
  const range = resolveDashboardRange(
    url.searchParams.get('from') ?? undefined,
    url.searchParams.get('to') ?? undefined,
  );
  // データ層を取り、**認証情報から取り出したテナント**の数値を引く（ADR-0002）
  const repos = await getRepos();
  const summary = await loadDashboardSummary(repos, session.principal.tenantId, range.window);
  // 画面と同じ集計から CSV を組み立てる
  const csv = buildDailyReportCsv(summary);
  // ダウンロードとして返す
  // status を書かない（Response の既定が 200。HTTP_STATUS に OK を足さないのは、
  // 既存のルートも成功時は既定に任せているため）
  return new Response(csv, {
    headers: {
      // 文字コードを明示する（CSV 本文の先頭にも BOM を付けている）
      'Content-Type': 'text/csv; charset=utf-8',
      // ファイル名は期間が分かる形にする
      'Content-Disposition': `attachment; filename="${dailyReportFileName(range.fromText, range.toText)}"`,
      // **キャッシュさせない** — テナントごとに中身が違うので、共有キャッシュに載ると他テナントへ漏れる
      'Cache-Control': 'private, no-store',
    },
  });
}
