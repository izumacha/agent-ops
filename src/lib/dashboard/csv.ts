// 日次レポート（CSV）の組み立て（Step5）。
//
// **画面と同じ `DashboardSummary` から作る**ので、表に出ている数字と CSV の数字が食い違わない
// （受け入れ基準「表示データと DB 集計の突合」を 1 本で満たす形を崩さない。§6 DRY）。
import { formatMicroUsdAsUsd } from '@/domain/money';
import { uptimeRate } from '@/domain/uptime';
import { UI_TEXT } from '@/lib/constants';
import type { DashboardSummary } from './summary';

// 列の見出し（画面の表と同じ文言を使う。見出しが 2 か所で割れないようにする）
const COLUMNS = [
  UI_TEXT.columnDay,
  UI_TEXT.columnRequests,
  UI_TEXT.columnErrors,
  UI_TEXT.columnUptime,
  UI_TEXT.columnCost,
  UI_TEXT.columnInputTokens,
  UI_TEXT.columnOutputTokens,
] as const;

/**
 * 1 つのセルを CSV の形へ逃がす。
 *
 * **`"` を含む値・区切り文字・改行を含む値は引用符で囲む**（RFC 4180）。この表に入る値は
 * 日付と数字だけなので実際には必要にならないが、**列を足した人が文字列を入れたときに
 * 列がずれる**（= 別の列の値として読まれる）のを防ぐために常に通す。
 */
function escapeCell(value: string): string {
  // 囲む必要があるか（区切り・引用符・改行のいずれかを含むか）
  const needsQuotes = /[",\r\n]/.test(value);
  // 必要なければそのまま
  if (!needsQuotes) return value;
  // 引用符は 2 つ重ねて逃がし、全体を引用符で囲む
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * 日次レポートの CSV 本文を作る。
 *
 * **先頭に BOM を付ける。** 付けないと Excel が UTF-8 と判断せず、日本語の見出しが文字化けする
 * （運用者が最初に開くのは Excel という前提。付けても他のツールは読める）。
 * 改行は CRLF（RFC 4180）。
 */
export function buildDailyReportCsv(summary: DashboardSummary): string {
  // 見出しの行
  const rows: string[] = [COLUMNS.map(escapeCell).join(',')];
  // 日ごとの明細（画面の表と同じ順・同じ値）
  for (const row of summary.daily) {
    // 稼働率は画面と同じドメイン関数から出す（CSV 側で割り算しない）
    const rate = uptimeRate(row.requests, row.errorRequests);
    rows.push(
      [
        row.day,
        String(row.requests),
        String(row.errorRequests),
        // 測れていない日は空欄にする（0 と書くと「稼働率 0%」と読まれる）
        rate === null ? '' : rate.toFixed(4),
        formatMicroUsdAsUsd(row.costMicroUsd),
        String(row.inputTokens),
        String(row.outputTokens),
      ]
        .map(escapeCell)
        .join(','),
    );
  }
  // BOM + CRLF 区切り（末尾にも改行を置く）
  // **BOM は \uFEFF のエスケープで書く** — 生の文字で書くとレビューで見えない
  return `\uFEFF${rows.join('\r\n')}\r\n`;
}

/** ダウンロード時のファイル名を作る（期間が分かる名前にする）。 */
export function dailyReportFileName(fromText: string, toText: string): string {
  // 日付はハイフン区切りなのでそのまま使える（パス区切りや引用符は入らない）
  return `agent-ops-daily-${fromText}_${toText}.csv`;
}
