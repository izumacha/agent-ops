// 集計値の BIGINT → number 変換 (src/data/safe-count.ts) の境界。
// アダプタの中に埋まっていたときは検査が無く、上限の判定を消しても負の値を通しても全件緑だった
import { describe, expect, it } from 'vitest';
import { toSafeCount } from '@/data/safe-count';

describe('集計値の数値化', () => {
  it.each([
    ['0', 0n, 0],
    ['小さい値', 1_234n, 1_234],
    ['安全な整数の上限ちょうど', BigInt(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ])('%s は数値へ写す', (_label, value, expected) => {
    // 範囲内の値はそのまま number になる
    expect(toSafeCount(value, '呼び出し回数')).toBe(expected);
  });

  it('安全な整数の上限を 1 超えると落とす (静かに丸めない)', () => {
    // 丸めて返すと請求や上限判定が黙ってずれる
    expect(() => toSafeCount(BigInt(Number.MAX_SAFE_INTEGER) + 1n, '入力トークン')).toThrow(
      /入力トークン/,
    );
  });

  it('負の値も落とす (符号を取り違えた集計を素通ししない)', () => {
    // 回数・トークン数は 0 以上しか取り得ない
    expect(() => toSafeCount(-1n, '出力トークン')).toThrow(/出力トークン/);
  });

  it('失敗の文言はどの項目かを名指しする (原因の列が分かる)', () => {
    // ラベルがそのままメッセージに出る
    expect(() => toSafeCount(-1n, '呼び出し回数')).toThrow(/呼び出し回数/);
  });
});
