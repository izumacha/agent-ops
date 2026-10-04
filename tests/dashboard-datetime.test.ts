// 日時の見せ方（`src/lib/dashboard/datetime.ts`）を固定するテスト。
//
// **純粋関数なので単体テストで縛る**（§11）。表に出る文字列なので、形が崩れると
// 列幅の都合で理由の文が折り返し、画面の読みやすさが静かに戻る（それが導入の動機）。
import { describe, expect, it } from 'vitest';
import { formatUtcMinute } from '@/lib/dashboard/datetime';

describe('formatUtcMinute', () => {
  it('UTC の分までを YYYY-MM-DD HH:mm の形で返す', () => {
    // 秒とミリ秒を持つ日時（保存されている値と同じ形）
    const value = new Date('2026-10-04T08:02:24.428Z');
    // 秒・ミリ秒・`T`・`Z` が落ちて分までになる
    expect(formatUtcMinute(value)).toBe('2026-10-04 08:02');
  });

  it('ローカルのタイムゾーンに引きずられず UTC のまま出す', () => {
    // UTC では日付が変わる直前、JST では翌日になる瞬間
    const value = new Date('2026-10-04T15:30:00.000Z');
    // 変換しないので UTC の日付・時刻がそのまま出る（列見出しの「(UTC)」と一致する）
    expect(formatUtcMinute(value)).toBe('2026-10-04 15:30');
  });

  it('1 桁の月日・時分を 0 で埋めた形にする', () => {
    // 月・日・時・分がすべて 1 桁になる日時
    const value = new Date('2026-01-02T03:04:05.000Z');
    // 桁がそろうので列の中で縦に読める
    expect(formatUtcMinute(value)).toBe('2026-01-02 03:04');
  });
});
