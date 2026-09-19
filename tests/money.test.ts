// マイクロ USD の文字列 → BigInt 変換 (src/domain/money.ts) の境界値
import { describe, expect, it } from 'vitest';
import { MICRO_USD_MAX, parseMicroUsd } from '@/domain/money';

describe('parseMicroUsd', () => {
  it('0・上限値・先頭 0 付きを受け付ける', () => {
    // 0
    expect(parseMicroUsd('0')).toBe(0n);
    // BIGINT の上限
    expect(parseMicroUsd(MICRO_USD_MAX.toString())).toBe(MICRO_USD_MAX);
    // 先頭 0
    expect(parseMicroUsd('007')).toBe(7n);
  });

  it('上限 + 1・20 桁・負数・小数・空文字・空白・指数表記は null', () => {
    // 形または範囲が外れる入力
    for (const value of [
      (MICRO_USD_MAX + 1n).toString(),
      '10000000000000000000',
      '-1',
      '1.5',
      '',
      ' 1',
      '1e6',
      '１２',
    ]) {
      expect(parseMicroUsd(value), value).toBeNull();
    }
  });
});
