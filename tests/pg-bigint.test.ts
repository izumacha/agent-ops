// PostgreSQL の `BIGINT` に収める変換（`src/domain/pg-bigint.ts`）の境界。
//
// **この 1 か所が 2 つの用途を支えている** — 金額（マイクロ USD）と監査ログの連番。
// どちらも「範囲外の値が DB へ届くと、利用者の入力が原因なのに 500 になる」経路なので、
// 形と範囲の両側をここで固定する（§11 の境界値重視）。
import { describe, expect, it } from 'vitest';
import { PG_BIGINT_MAX, PG_BIGINT_MAX_DIGITS, parsePgBigint } from '@/domain/pg-bigint';

describe('BIGINT の範囲', () => {
  it('上限は 2^63 - 1 で、桁数は 19', () => {
    // 列の型が決める値（ここが動くと両方の用途の上限が動く）
    expect(PG_BIGINT_MAX).toBe(2n ** 63n - 1n);
    // 桁数は上限から導いてある（写しを持たない）
    expect(PG_BIGINT_MAX_DIGITS).toBe(19);
  });
});

describe('BIGINT への変換', () => {
  it.each([
    ['最小の正の値', '1', 1n],
    ['上限ちょうど', PG_BIGINT_MAX.toString(), PG_BIGINT_MAX],
    ['0', '0', 0n],
    // 先頭の 0 は許す（カーソルのように機械が組み立てた値が来ることがある）
    ['先頭に 0 が付く値', '007', 7n],
  ])('%s は BigInt になる', (_label, value, expected) => {
    // 変換できた値はそのまま where へ渡せる
    expect(parsePgBigint(value)).toBe(expected);
  });

  it.each([
    // **値の上限**（桁数は収まるので、比較が無いと素通りする）
    ['上限の 1 つ上', (PG_BIGINT_MAX + 1n).toString()],
    ['19 桁の最大値', '9'.repeat(PG_BIGINT_MAX_DIGITS)],
    // **桁数の上限**（`BigInt` へ直す前に落ちる経路）
    ['桁数の上限より 1 桁長い値', '1'.repeat(PG_BIGINT_MAX_DIGITS + 1)],
    // 形が違うもの（`BigInt('')` は 0 になるので空文字は必ず弾く）
    ['空文字', ''],
    ['符号付き', '-1'],
    ['先頭に + が付く値', '+1'],
    ['小数', '1.5'],
    ['指数表記', '1e3'],
    ['前後に空白が付く値', ' 1 '],
    ['数字でない文字', 'abc'],
    ['全角の数字', '１'],
  ])('%s は null になる', (_label, value) => {
    // 呼び出し側は null を 422 に写す（例外にしない）
    expect(parsePgBigint(value)).toBeNull();
  });
});
