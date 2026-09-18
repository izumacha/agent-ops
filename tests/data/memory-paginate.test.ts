// memory アダプタのページネーション (createdAt → id 順・カーソル・次ページ判定)
import { describe, expect, it } from 'vitest';
import { paginate } from '@/data/adapters/memory/paginate';
import { decodeCursor, encodeCursor } from '@/data/page';

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
  it('limit が 1 未満・整数でない呼び出しは fail-closed で落ちる (toPage の items[-1] に到達させない)', () => {
    // 0 / 負数 / 小数はいずれも RangeError
    for (const limit of [0, -1, 1.5]) {
      expect(() => paginate(rows, { limit })).toThrow(RangeError);
    }
  });

  it('createdAt 昇順、同時刻は id 昇順で並ぶ', () => {
    // 全件
    const page = paginate(rows, { limit: 10 });
    expect(page.items.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(page.nextCursor).toBeUndefined();
  });

  it('limit 件ずつ切り出し、最終行の位置 (createdAt, id) を nextCursor にする', () => {
    // 2 件ずつ 3 ページ
    const p1 = paginate(rows, { limit: 2 });
    expect(p1.items.map((r) => r.id)).toEqual(['a', 'b']);
    expect(decodeCursor(p1.nextCursor!)).toEqual({ createdAt: T0, id: 'b' });
    const p2 = paginate(rows, { limit: 2, cursor: decodeCursor(p1.nextCursor!)! });
    expect(p2.items.map((r) => r.id)).toEqual(['c', 'd']);
    const p3 = paginate(rows, { limit: 2, cursor: decodeCursor(p2.nextCursor!)! });
    expect(p3.items.map((r) => r.id)).toEqual(['e']);
    expect(p3.nextCursor).toBeUndefined();
  });

  it('ちょうど limit 件で終わるときは nextCursor を付けない', () => {
    // 5 件を limit 5 で
    const page = paginate(rows, { limit: 5 });
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBeUndefined();
  });

  it('一覧に無い行の位置をカーソルにしても、その位置より後ろの行が続きとして取れる (行が消えても途切れない)', () => {
    // 'c' と同時刻で id が 'c' より後・'d' より前の位置 (削除された行を模す)
    const cursor = { createdAt: new Date(T0.getTime() + 1000), id: 'cc' };
    expect(paginate(rows, { limit: 10, cursor }).items.map((r) => r.id)).toEqual(['d', 'e']);
  });

  it('壊れたカーソルは復号できず null になる (API 層で 422 にする)', () => {
    // 形が違う文字列
    for (const value of [
      'zzz',
      '',
      Buffer.from('abc').toString('base64url'),
      Buffer.from('12:').toString('base64url'),
      Buffer.from('12:a\u0000b').toString('base64url'),
    ]) {
      expect(decodeCursor(value), value).toBeNull();
    }
    // 符号化 → 復号が往復する
    const key = { createdAt: new Date(1_726_000_000_000), id: 'cuid_x' };
    expect(decodeCursor(encodeCursor(key))).toEqual(key);
  });
});
