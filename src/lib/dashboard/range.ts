// ダッシュボードの「期間」の解釈（Step5）。画面と CSV の両方がここを通る（§6 DRY）。
//
// **期間の規則そのものは `src/domain/usage-window.ts` が正本**（UTC の日境界・上限日数）。
// ここがやるのは「クエリが無いときの既定」と「読めない値をどう扱うか」だけ。
import { USAGE_RANGE_MAX_DAYS, DASHBOARD_DEFAULT_RANGE_DAYS, UI_TEXT } from '@/lib/constants';
import { type UsageWindow, formatUtcDay, resolveUsageWindow } from '@/domain/usage-window';

// 1 日のミリ秒（既定の期間を組み立てるのに使う）
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

// 解釈した期間と、入力をそのまま採用できたかどうか
export interface DashboardRange {
  window: UsageWindow;
  // 画面の日付入力に出す値（YYYY-MM-DD）
  fromText: string;
  toText: string;
  // **受け取ったのに採用しなかったか**。true なら画面が「指定は適用していません」と伝える。
  // 黙って既定へ倒すと、利用者は絞ったつもりの数字を本物だと読む
  ignoredInput: boolean;
  // 採用しなかった理由の文言（採用したときは null）
  ignoredReason: string | null;
}

/**
 * クエリの `from` / `to` から期間を決める。読めない・逆順・長すぎるときは**既定の期間へ倒し、
 * 旗を立てる**（画面が注意書きを出す）。
 *
 * **既定は「今日を含む直近 N 日」**。`now` を引数に取るのは、テストで時刻を固定できるようにするため。
 */
export function resolveDashboardRange(
  from: string | undefined,
  to: string | undefined,
  now: Date = new Date(),
): DashboardRange {
  // 既定の期間（今日を終わりとする N 日間）を組み立てる
  const defaultTo = formatUtcDay(now);
  const defaultFrom = formatUtcDay(
    new Date(now.getTime() - (DASHBOARD_DEFAULT_RANGE_DAYS - 1) * MILLIS_PER_DAY),
  );
  // どちらも指定が無ければ既定をそのまま使う（旗は立てない）
  if (from === undefined && to === undefined) {
    const resolved = resolveUsageWindow(defaultFrom, defaultTo, USAGE_RANGE_MAX_DAYS);
    // 既定は必ず読めるので、万一失敗したら前提が崩れている（開発時に気付けるよう投げる）
    if (!resolved.ok) throw new Error('既定の期間を解釈できませんでした');
    return {
      window: resolved.window,
      fromText: defaultFrom,
      toText: defaultTo,
      ignoredInput: false,
      ignoredReason: null,
    };
  }
  // 片方だけの指定も受け付ける（欠けた側は既定で埋める）
  const fromText = from ?? defaultFrom;
  const toText = to ?? defaultTo;
  // 規則の判定はドメインに任せる
  const resolved = resolveUsageWindow(fromText, toText, USAGE_RANGE_MAX_DAYS);
  // 通れば採用する
  if (resolved.ok) {
    return { window: resolved.window, fromText, toText, ignoredInput: false, ignoredReason: null };
  }
  // 通らなければ既定へ倒す（ここは「読めなかった」ので必ず読める既定で描く）
  const fallback = resolveUsageWindow(defaultFrom, defaultTo, USAGE_RANGE_MAX_DAYS);
  if (!fallback.ok) throw new Error('既定の期間を解釈できませんでした');
  return {
    window: fallback.window,
    fromText: defaultFrom,
    toText: defaultTo,
    // **採用しなかったことを必ず伝える**（黙って既定に倒すと数字を誤読させる）
    ignoredInput: true,
    ignoredReason: UI_TEXT.rangeIgnored,
  };
}
