// 「limit + 1 件取って次ページの有無を判定し、最終行の id を nextCursor にする」規則の唯一の定義。
// memory / prisma の両アダプタが使う (片方だけカーソルの約束を変えると、memory で通る API テストが本番を表さなくなる)
import type { Page } from './ports/types';

// 1 件多く取った行を 1 ページに整形する
export function toPage<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  // 次ページがあるか (limit + 1 件取れたか)
  const hasMore = rows.length > limit;
  // 返す分だけに切り詰める
  const items = hasMore ? rows.slice(0, limit) : rows;
  // 次ページがあれば最終行の id をカーソルにする
  return hasMore ? { items, nextCursor: items[items.length - 1].id } : { items };
}
