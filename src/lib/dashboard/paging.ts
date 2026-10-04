// ダッシュボードの一覧画面が URL のクエリからページ送りの位置を読む規則（Step5）。
//
// **カーソルの形そのものは `src/data/page.ts` が正本**（最終行の `(createdAt, id)` を符号化した
// 不透明な値）。ここがやるのは「読めない値をどう扱うか」だけで、期間の解釈
// （`src/lib/dashboard/range.ts`）と同じ流儀にそろえている。
import { decodeCursor, type CursorKey } from '@/data/page';
import { PAGE_CURSOR_MAX_LENGTH, UI_TEXT } from '@/lib/constants';

// 解釈したページ送りの位置と、入力をそのまま採用できたかどうか
export interface DashboardCursor {
  // 復号できた位置（先頭から読むときは undefined）
  cursor?: CursorKey;
  // **受け取ったのに採用しなかったか**。true なら画面が「先頭から表示しています」と伝える。
  // 黙って先頭へ戻すと、利用者は「続きを見た」つもりで同じ 1 ページ目を読む
  ignoredInput: boolean;
  // 採用しなかった理由の文言（採用したときは null）
  ignoredReason: string | null;
}

/**
 * クエリの `cursor` を復号する。読めない値は**先頭から**に倒し、旗を立てる。
 *
 * 長すぎる値は復号を試す前に落とす（§9 入力は信用しない。上限は API と同じ定数）。
 */
export function resolveDashboardCursor(raw: string | undefined): DashboardCursor {
  // 指定が無ければ先頭から（旗は立てない）
  if (raw === undefined || raw.length === 0) {
    return { ignoredInput: false, ignoredReason: null };
  }
  // 異常に長い値は復号を試さずに断る
  if (raw.length > PAGE_CURSOR_MAX_LENGTH) {
    return { ignoredInput: true, ignoredReason: UI_TEXT.cursorIgnored };
  }
  // 復号する（形が違えば null が返る）
  const cursor = decodeCursor(raw);
  // 復号できなければ先頭へ倒し、採用しなかったことを伝える
  if (cursor === null) {
    return { ignoredInput: true, ignoredReason: UI_TEXT.cursorIgnored };
  }
  // 採用した位置を返す
  return { cursor, ignoredInput: false, ignoredReason: null };
}
