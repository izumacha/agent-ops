// 集計期間の規則 (src/domain/usage-window.ts)。日の境目は UTC で、API と両アダプタが同じ規則を使う
import { describe, expect, it } from 'vitest';
import { formatUtcDay, parseUtcDay, resolveUsageWindow } from '@/domain/usage-window';

describe('UTC の日付の読み書き', () => {
  it('YYYY-MM-DD を UTC の 0 時として読む', () => {
    // 2026-03-01 は UTC の 0 時
    expect(parseUtcDay('2026-03-01')?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it.each([
    ['存在しない日 (2 月 30 日)', '2026-02-30'],
    ['存在しない月', '2026-13-01'],
    ['桁が足りない', '2026-3-1'],
    ['日時になっている', '2026-03-01T00:00:00Z'],
    ['空文字', ''],
  ])('%s は読めない (繰り上がりで別の日にしない)', (_label, text) => {
    // Date の自動繰り上がりに任せず null にする
    expect(parseUtcDay(text)).toBeNull();
  });

  it('うるう年の 2 月 29 日は読める', () => {
    // 2028 はうるう年
    expect(parseUtcDay('2028-02-29')).not.toBeNull();
    // 2026 はうるう年ではない
    expect(parseUtcDay('2026-02-29')).toBeNull();
  });

  it('Date を UTC の日付文字列にする', () => {
    // 時刻を持つ Date でも日付だけになる
    expect(formatUtcDay(new Date('2026-03-01T23:59:59Z'))).toBe('2026-03-01');
  });
});

describe('集計期間の組み立て', () => {
  it('終了日を含む半開区間になる (終了日の翌日 0 時が終わり)', () => {
    // 1 日から 3 日まで
    const resolved = resolveUsageWindow('2026-03-01', '2026-03-03', 366);
    // 成功していること
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // 開始は 1 日の 0 時、終わり (含まない) は 4 日の 0 時
    expect(resolved.window.start.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(resolved.window.endExclusive.toISOString()).toBe('2026-03-04T00:00:00.000Z');
    // 日数は 3
    expect(resolved.window.days).toBe(3);
  });

  it('同じ日を指定したら 1 日分になる', () => {
    // 1 日だけ
    const resolved = resolveUsageWindow('2026-03-01', '2026-03-01', 366);
    expect(resolved.ok && resolved.window.days).toBe(1);
  });

  it('読めない日付は理由 invalid_day', () => {
    // 存在しない日
    const resolved = resolveUsageWindow('2026-02-30', '2026-03-01', 366);
    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.reason).toBe('invalid_day');
  });

  it('開始が終了より後なら理由 reversed', () => {
    // 逆順
    const resolved = resolveUsageWindow('2026-03-05', '2026-03-01', 366);
    expect(!resolved.ok && resolved.reason).toBe('reversed');
  });

  it('上限ちょうどは通り、1 日超えると理由 too_long', () => {
    // 上限 3 日として、3 日はよい
    expect(resolveUsageWindow('2026-03-01', '2026-03-03', 3).ok).toBe(true);
    // 4 日は超過
    const tooLong = resolveUsageWindow('2026-03-01', '2026-03-04', 3);
    expect(!tooLong.ok && tooLong.reason).toBe('too_long');
  });

  it('夏時間の切り替わりを跨いでも日数はカレンダーどおり (UTC で数える)', () => {
    // 多くの地域で夏時間が切り替わる 3 月末を跨ぐ
    const resolved = resolveUsageWindow('2026-03-28', '2026-03-30', 366);
    // 3 日 (ローカル時刻の 23 時間の日があっても影響しない)
    expect(resolved.ok && resolved.window.days).toBe(3);
  });
});
