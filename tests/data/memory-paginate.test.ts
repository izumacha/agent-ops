// memory アダプタのページネーション (createdAt → id 順・カーソル・次ページ判定)
import { describe, expect, it } from 'vitest';
import { paginate } from '@/data/adapters/memory/paginate';

// 同時刻を含む 5 行 (id の順序は挿入順とずらす)
const T0 = new Date('2026-09-17T00:00:00Z');
const rows = [
  { id: 'c', createdAt: new Date(T0.getTime() + 1000) },
  { id: 'a', createdAt: T0 },
  { id: 'e', createdAt: new Date(T0.getTime() + 2000) },
  { id: 'b', createdAt: T0 },
  { id: 'd', createdAt: new Date(T0.getTime() + 1000) },
];

describe('paginate', () => {
  it('createdAt 昇順、同時刻は id 昇順で並ぶ', () => {
    // 全件
    const page = paginate(rows, { limit: 10 });
    expect(page.items.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(page.nextCursor).toBeUndefined();
  });

  it('limit 件ずつ切り出し、最終行の id を nextCursor にする', () => {
    // 2 件ずつ 3 ページ
    const p1 = paginate(rows, { limit: 2 });
    expect(p1.items.map((r) => r.id)).toEqual(['a', 'b']);
    expect(p1.nextCursor).toBe('b');
    const p2 = paginate(rows, { limit: 2, cursor: p1.nextCursor });
    expect(p2.items.map((r) => r.id)).toEqual(['c', 'd']);
    const p3 = paginate(rows, { limit: 2, cursor: p2.nextCursor });
    expect(p3.items.map((r) => r.id)).toEqual(['e']);
    expect(p3.nextCursor).toBeUndefined();
  });

  it('ちょうど limit 件で終わるときは nextCursor を付けない', () => {
    // 5 件を limit 5 で
    const page = paginate(rows, { limit: 5 });
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBeUndefined();
  });

  it('存在しないカーソルは空ページ (prisma の挙動に合わせる)', () => {
    // 未知の id
    expect(paginate(rows, { limit: 2, cursor: 'zzz' }).items).toHaveLength(0);
  });
});
