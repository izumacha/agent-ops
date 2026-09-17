// memory アダプタ用のページネーション (純粋関数)。並び順・カーソルの規則は src/data/page.ts (prisma アダプタと共有)
import { isAfterCursor, toPage, type CursorKey } from '@/data/page';
import type { Page, PageQuery } from '@/data/ports';

// createdAt → id の順で安定ソートする比較関数
function compare(a: CursorKey, b: CursorKey): number {
  // まず作成日時で比べる
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  // 同時刻なら id の文字列順で決める (順序を決定的にする)
  return byTime !== 0 ? byTime : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// 行の配列から 1 ページ分を切り出す
export function paginate<T extends CursorKey>(rows: Iterable<T>, query: PageQuery): Page<T> {
  // 安定した順序に並べる (元の配列は変更しない)
  const sorted = [...rows].sort(compare);
  // カーソルがあれば、その位置より後ろの行だけにする (行が消えていても位置の比較なので続きが取れる)
  const key = query.cursor;
  const after = key ? sorted.filter((row) => isAfterCursor(row, key)) : sorted;
  // 1 件多く取り、共通の規則でページに整形する (prisma アダプタと同じ)
  const page = toPage(after.slice(0, query.limit + 1), query.limit);
  // 行の複製を返す (呼び出し側が戻り値を書き換えても表が壊れないようにする。全 list() で必ず通る 1 か所)
  return { ...page, items: page.items.map((row) => ({ ...row })) };
}
