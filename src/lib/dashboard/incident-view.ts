// インシデント一覧の「どれを見るか」の解釈（Step5）。
//
// 既定は**未解決だけ**（運用で見たいのはまず未解決。ダッシュボードの「未解決インシデント」から
// 飛んできたときに解決済みが混ざらない）。解決済みも含めて見たいときはクエリで切り替える。
//
// **読めない値は既定へ倒し、旗を立てる**（期間とカーソルと同じ流儀。黙って倒すと、
// 利用者は「すべて見た」つもりで未解決だけを読む）。
import { IncidentStatus } from '@/domain/types';
import { UI_TEXT } from '@/lib/constants';

// クエリに書ける値。**ここが唯一の定義**で、画面のリンクも検証もこれを読む
export const INCIDENT_VIEW_ALL = 'all';
export const INCIDENT_VIEW_OPEN = 'open';

// 解釈した表示条件
export interface IncidentView {
  // 一覧の絞り込みに渡す状態（すべて見るときは undefined）
  status?: IncidentStatus;
  // すべて表示しているか（リンクの出し分けに使う）
  showAll: boolean;
  // **受け取ったのに採用しなかったか**
  ignoredInput: boolean;
  // 採用しなかった理由の文言（採用したときは null）
  ignoredReason: string | null;
}

/**
 * クエリの `status` を解釈する。`all` ならすべて、`open` と未指定なら未解決だけ。
 * それ以外の値は既定（未解決だけ）へ倒し、採用しなかったことを旗で伝える。
 */
export function resolveIncidentView(raw: string | undefined): IncidentView {
  // すべて見る指定
  if (raw === INCIDENT_VIEW_ALL) {
    return { showAll: true, ignoredInput: false, ignoredReason: null };
  }
  // 未解決だけ（明示された場合と、指定が無い場合）
  if (raw === INCIDENT_VIEW_OPEN || raw === undefined || raw.length === 0) {
    return {
      status: IncidentStatus.open,
      showAll: false,
      ignoredInput: false,
      ignoredReason: null,
    };
  }
  // 知らない値は既定へ倒し、採用しなかったことを伝える
  return {
    status: IncidentStatus.open,
    showAll: false,
    ignoredInput: true,
    ignoredReason: UI_TEXT.incidentViewIgnored,
  };
}
