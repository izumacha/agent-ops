// 10 進整数の文字列判定 (API の limit と CLI の --days が共有する規則) の境界値
import { describe, expect, it } from 'vitest';
import { DECIMAL_INTEGER_MAX_DIGITS, parseDecimalInteger } from '@/domain/decimal-integer';

describe('parseDecimalInteger', () => {
  it('10 進の数字だけを数値にする (先頭の 0 も 10 進として読む)', () => {
    // 通常の値
    expect(parseDecimalInteger('5')).toBe(5);
    expect(parseDecimalInteger('200')).toBe(200);
    // 先頭の 0 は 8 進ではなく 10 進
    expect(parseDecimalInteger('007')).toBe(7);
    // 上限桁ちょうど
    expect(parseDecimalInteger('9'.repeat(DECIMAL_INTEGER_MAX_DIGITS))).toBe(
      Number('9'.repeat(DECIMAL_INTEGER_MAX_DIGITS)),
    );
  });

  it('Number() なら通る形 (16 進・指数・符号・空白・小数) と空・桁数超過は null', () => {
    // Number() では 16 / 100 / 5 / 5 / 5 / 1.5 になる形
    for (const text of ['0x10', '1e2', '+5', ' 5 ', '5 ', '1.5', '-1']) {
      expect(parseDecimalInteger(text), text).toBeNull();
    }
    // 空文字と桁数超過
    expect(parseDecimalInteger('')).toBeNull();
    expect(parseDecimalInteger('1'.repeat(DECIMAL_INTEGER_MAX_DIGITS + 1))).toBeNull();
  });
});
