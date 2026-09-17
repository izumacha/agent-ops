// memory アダプタ用のページネーション (純粋関数)。並び順は prisma アダプタと同じ「createdAt 昇順 → id 昇順」、
// カーソルは「前ページ最終行の id」。存在しないカーソルは prisma の挙動 (空の結果) に合わせる
import { toPage } from '@/data/page';
import type { Page, PageQuery } from '@/data/ports';

// 並び順の基準になる最小限の形
interface Sortable {
  id: string;
  createdAt: Date;
}

// createdAt → id の順で安定ソートする比較関数
function compare(a: Sortable, b: Sortable): number {
  // まず作成日時で比べる
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  // 同時刻なら id の文字列順で決める (順序を決定的にする)
  return byTime !== 0 ? byTime : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// 行の配列から 1 ページ分を切り出す
export function paginate<T extends Sortable>(rows: Iterable<T>, query: PageQuery): Page<T> {
  // 安定した順序に並べる (元の配列は変更しない)
  const sorted = [...rows].sort(compare);
  // カーソルの次の行から始める (カーソル無しなら先頭、見つからなければ空)
  let start = 0;
  if (query.cursor !== undefined) {
    // カーソルが指す行の位置
    const index = sorted.findIndex((row) => row.id === query.cursor);
    // 見つからなければ空ページ (prisma の cursor 未一致と同じ)
    if (index === -1) return { items: [] };
    // その次から
    start = index + 1;
  }
  // 1 件多く取り、共通の規則でページに整形する (prisma アダプタと同じ)
  return toPage(sorted.slice(start, start + query.limit + 1), query.limit);
}
