// 日次レポート（CSV）と期間の解釈（Step5）の検査。
//
// CSV は**画面と同じ `DashboardSummary` から作る**ので、ここで固定するのは
// 「表に出ている数字がそのまま出るか」と「列がずれない形になっているか」。
import { describe, expect, it } from 'vitest';
import { formatUptimePercent, uptimeRate } from '@/domain/uptime';
import { UI_TEXT, DASHBOARD_DEFAULT_RANGE_DAYS, USAGE_RANGE_MAX_DAYS } from '@/lib/constants';
import { buildDailyReportCsv, dailyReportFileName } from '@/lib/dashboard/csv';
import { resolveDashboardRange } from '@/lib/dashboard/range';
import type { DashboardSummary } from '@/lib/dashboard/summary';

// 検査に使う集計結果（画面が受け取るものと同じ形）
const SUMMARY: DashboardSummary = {
  window: {
    start: new Date('2026-05-01T00:00:00Z'),
    endExclusive: new Date('2026-05-03T00:00:00Z'),
    days: 2,
  },
  requests: 5,
  errorRequests: 1,
  uptimeRate: 0.8,
  costMicroUsd: 1_500_000n,
  quality: null,
  openIncidents: 0,
  openIncidentsReachedLimit: false,
  daily: [
    {
      day: '2026-05-01',
      requests: 4,
      errorRequests: 1,
      inputTokens: 40,
      outputTokens: 80,
      costMicroUsd: 1_250_000n,
    },
    {
      day: '2026-05-02',
      requests: 1,
      errorRequests: 0,
      inputTokens: 10,
      outputTokens: 20,
      costMicroUsd: 250_000n,
    },
  ],
};

// CSV を行に割る（BOM は先頭から外して見る）
function rowsOf(csv: string): string[] {
  return csv.replace(/^﻿/, '').trimEnd().split('\r\n');
}

describe('日次レポートの CSV', () => {
  it('先頭に BOM を付け、CRLF で区切る', () => {
    // Excel が UTF-8 と判断できるように BOM を付ける（無いと日本語の見出しが文字化けする）
    const csv = buildDailyReportCsv(SUMMARY);
    expect(csv.startsWith('﻿')).toBe(true);
    // 改行は CRLF（RFC 4180）
    expect(csv).toContain('\r\n');
  });

  it('見出しは画面の表と同じ文言を使う（稼働率だけは単位を足した見出し）', () => {
    // 見出しが 2 か所で割れないよう、画面と同じ定数から作る
    const [header] = rowsOf(buildDailyReportCsv(SUMMARY));
    expect(header).toBe(
      [
        UI_TEXT.columnDay,
        UI_TEXT.columnRequests,
        UI_TEXT.columnErrors,
        // **画面の `稼働率` ではなく単位付きの見出し** — CSV のセルには「%」を書かないので、
        // 単位が見出しに無いと 0〜1 の割合と読まれる
        UI_TEXT.columnUptimePercent,
        UI_TEXT.columnCost,
        UI_TEXT.columnInputTokens,
        UI_TEXT.columnOutputTokens,
      ].join(','),
    );
    // 単位が実際に書かれていること（見出しの定数を素の「稼働率」に戻す変異をここで落とす）
    expect(UI_TEXT.columnUptimePercent).toContain('%');
  });

  it('日次の明細をそのまま出す（金額は BigInt のまま整形する）', () => {
    // 2 日分が順に出る
    const rows = rowsOf(buildDailyReportCsv(SUMMARY));
    expect(rows).toHaveLength(3);
    // 1 日目: 4 件中 1 件失敗 → 稼働率 75.0%、料金 1.25 USD
    expect(rows[1]).toBe('2026-05-01,4,1,75.0,1.25,40,80');
    // 2 日目: 失敗なし → 稼働率 100.0%
    expect(rows[2]).toBe('2026-05-02,1,0,100.0,0.25,10,20');
  });

  it('稼働率は画面の表示と同じ数字になる（単位の記号だけが違う）', () => {
    // 画面は `formatUptimePercent` の値に「%」を足して出す（src/app/(dashboard)/dashboard/page.tsx）。
    // **ここが割れると、同じ見出しの列を突き合わせた運用者が 100 分の 1 に読み違える**
    const rate = uptimeRate(4, 1);
    // 型の都合で null を先に落とす（4 件中 1 件なので必ず数になる）
    expect(rate).not.toBeNull();
    // CSV のセルと、画面が「%」を外した値が一致する
    const cell = rowsOf(buildDailyReportCsv(SUMMARY))[1]?.split(',')[3];
    expect(cell).toBe(formatUptimePercent(rate as number));
  });

  it('測れていない日の稼働率は空欄にする（0 と書かない）', () => {
    // 呼び出しが 0 件の日を 1 行だけ持つ集計
    const empty: DashboardSummary = {
      ...SUMMARY,
      daily: [
        {
          day: '2026-05-01',
          requests: 0,
          errorRequests: 0,
          inputTokens: 0,
          outputTokens: 0,
          costMicroUsd: 0n,
        },
      ],
    };
    // 稼働率の列が空（0 と書くと「稼働率 0%」と読まれる）
    expect(rowsOf(buildDailyReportCsv(empty))[1]).toBe('2026-05-01,0,0,,0.00,0,0');
  });

  it('明細が無ければ見出しだけを返す', () => {
    // 記録が無い期間でもファイルとして壊れない
    const none: DashboardSummary = { ...SUMMARY, daily: [] };
    expect(rowsOf(buildDailyReportCsv(none))).toHaveLength(1);
  });

  it('区切り・引用符・改行を含む値は引用符で囲む（列をずらさない）', () => {
    // 見出しは定数なので実際には入らないが、列を足した人が文字列を入れたときに備える。
    // ここでは整形関数が通る経路を、日付の位置に危険な文字を入れて確かめる
    const risky: DashboardSummary = {
      ...SUMMARY,
      daily: [
        {
          day: 'a,b"c\nd',
          requests: 1,
          errorRequests: 0,
          inputTokens: 0,
          outputTokens: 0,
          costMicroUsd: 0n,
        },
      ],
    };
    // 引用符で囲まれ、内側の引用符は 2 つに重ねられる
    expect(buildDailyReportCsv(risky)).toContain('"a,b""c\nd"');
  });

  it('ファイル名に期間が入る', () => {
    // 運用者が複数の期間を落としたときに見分けられる
    expect(dailyReportFileName('2026-05-01', '2026-05-31')).toBe(
      'agent-ops-daily-2026-05-01_2026-05-31.csv',
    );
  });
});

describe('ダッシュボードの期間の解釈', () => {
  // 時刻を固定して既定の期間を確かめる
  const NOW = new Date('2026-05-31T12:00:00Z');

  it('指定が無ければ今日を終わりとする既定の期間を使う', () => {
    // 既定は「今日を含む N 日間」
    const range = resolveDashboardRange(undefined, undefined, NOW);
    expect(range.toText).toBe('2026-05-31');
    expect(range.window.days).toBe(DASHBOARD_DEFAULT_RANGE_DAYS);
    // 指定していないので旗は立たない
    expect(range.ignoredInput).toBe(false);
  });

  it('読める指定はそのまま採用する', () => {
    // 1 日だけの期間
    const range = resolveDashboardRange('2026-05-10', '2026-05-10', NOW);
    expect(range.window.days).toBe(1);
    expect(range.ignoredInput).toBe(false);
  });

  it('片方だけの指定も受け付ける', () => {
    // 終了日だけを指定した場合、開始日は既定で埋める
    const range = resolveDashboardRange(undefined, '2026-05-10', NOW);
    expect(range.toText).toBe('2026-05-10');
    expect(range.ignoredInput).toBe(false);
  });

  it('読めない指定は既定へ倒し、採用しなかったことを旗で伝える', () => {
    // **これが要点** — 黙って既定へ倒すと、絞ったつもりの数字を本物だと読む
    for (const [from, to] of [
      ['not-a-date', '2026-05-10'],
      ['2026-05-10', 'not-a-date'],
      // 逆順（取り違え）
      ['2026-05-20', '2026-05-10'],
      // 上限より長い期間
      ['2020-01-01', '2026-05-31'],
    ]) {
      const range = resolveDashboardRange(from, to, NOW);
      // 既定の期間へ倒れている
      expect(range.window.days).toBe(DASHBOARD_DEFAULT_RANGE_DAYS);
      // 旗が立ち、理由の文言も付く
      expect(range.ignoredInput).toBe(true);
      expect(range.ignoredReason).toBe(UI_TEXT.rangeIgnored);
    }
  });

  it('入力欄を空にして送った側は「未指定」として扱い、もう片方の指定を捨てない', () => {
    // **画面の期間フォームは GET で 2 つの入力を必ず両方送る** ので、片方を消すと
    // `?from=2026-05-10&to=` の形で届く。空文字を「読めない値」と判定すると、
    // 指定した開始日まで捨てて既定へ倒れ、しかも「解釈できませんでした」と嘘の注意書きが出る
    const range = resolveDashboardRange('2026-05-10', '', NOW);
    // 指定した開始日が生きている
    expect(range.fromText).toBe('2026-05-10');
    // 欠けた側は既定（今日）で埋まる
    expect(range.toText).toBe('2026-05-31');
    // 採用できているので旗は立たない
    expect(range.ignoredInput).toBe(false);
  });

  it('両方とも空なら既定の期間になり、旗も立たない', () => {
    // 2 つとも空にして送った形（フォームを開いてすぐ送信した場合）
    const range = resolveDashboardRange('', '', NOW);
    // 既定の期間
    expect(range.window.days).toBe(DASHBOARD_DEFAULT_RANGE_DAYS);
    expect(range.toText).toBe('2026-05-31');
    // 何も指定していないのと同じなので旗は立たない
    expect(range.ignoredInput).toBe(false);
  });

  it('既定の期間は上限を超えない', () => {
    // 既定が上限より長いと、指定が無いだけで必ず解釈に失敗する
    expect(DASHBOARD_DEFAULT_RANGE_DAYS).toBeLessThanOrEqual(USAGE_RANGE_MAX_DAYS);
  });
});
