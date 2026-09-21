// JSON 本文の入れ子の深さを縛る判定 (src/lib/api/body.ts の exceedsMaxDepth)。
//
// **なぜ要るか**: サイズの上限だけでは資源の消費を縛れない。`JSON.parse` は深さ 10 万でも通るのに
// `JSON.stringify` は約 4,164 で RangeError になり、しかも**落ちなくても深い構造の stringify 自体が
// 重い** (実測: 同じ 65 KiB で深い本文 9.56ms 対 平坦 0.70ms = 13.6 倍)。上限を置かないと、
// 有効なキー 1 本・本文 8.4 KiB で 1 リクエストあたり 7ms の CPU を焼けた。
// 判定そのものが深い入力でスタックを食っては意味が無いので、実装は再帰ではなく明示のスタック
import { describe, expect, it } from 'vitest';
import { exceedsMaxDepth } from '@/lib/api/body';
import { JSON_BODY_MAX_DEPTH } from '@/lib/constants';

// 指定した段数だけ配列で包んだ値を作る (深さ = 入れ子になっている配列/オブジェクトの段数)
function nestedArray(depth: number): unknown {
  // いちばん内側の値 (これ自体は段数に数えない)
  let value: unknown = 1;
  // 外側へ 1 段ずつ包む
  for (let level = 0; level < depth; level += 1) value = [value];
  // 出来上がり
  return value;
}

describe('exceedsMaxDepth', () => {
  it.each([
    ['1 段', 1],
    ['上限より 1 浅い', JSON_BODY_MAX_DEPTH - 1],
    ['上限ちょうど', JSON_BODY_MAX_DEPTH],
  ])('上限以内なら false: %s', (_label, depth) => {
    // 正当な本文を落とさない側も固定する (片側だけだと「常に true」でも緑にできる)
    expect(exceedsMaxDepth(nestedArray(depth), JSON_BODY_MAX_DEPTH)).toBe(false);
  });

  it('上限を 1 超えたら true', () => {
    // 境界のすぐ外
    expect(exceedsMaxDepth(nestedArray(JSON_BODY_MAX_DEPTH + 1), JSON_BODY_MAX_DEPTH)).toBe(true);
  });

  it('オブジェクトの入れ子も数える', () => {
    // 配列だけを見ていると `{"a":{"a":…}}` の形が素通りする
    let value: unknown = 1;
    for (let level = 0; level < JSON_BODY_MAX_DEPTH + 1; level += 1) value = { a: value };
    expect(exceedsMaxDepth(value, JSON_BODY_MAX_DEPTH)).toBe(true);
  });

  it('幅が広いだけの本文は通す', () => {
    // 項目数が多くても深さは 2 段なので落とさない (サイズの上限が別に効く)
    const wide = Object.fromEntries(Array.from({ length: 5_000 }, (_v, i) => [`k${i}`, i]));
    expect(exceedsMaxDepth(wide, JSON_BODY_MAX_DEPTH)).toBe(false);
  });

  it('判定そのものは深い入力でも落ちない (再帰で書いていない)', () => {
    // **`JSON.stringify` が RangeError になる深さ**を与えても、判定は落ちずに true を返す
    expect(exceedsMaxDepth(nestedArray(20_000), JSON_BODY_MAX_DEPTH)).toBe(true);
  });
});

describe('JSON_BODY_MAX_DEPTH', () => {
  it('上限の値そのものを縛る (コスト側と RangeError 側の両方)', () => {
    // **コスト側を固定するのがここの主目的。** RangeError の余裕だけを見ていた版
    // (`toBeLessThan(3_000)`) では、上限を 2,999 に上げても 807 件すべて緑・件数も不変のまま、
    // 上限ちょうどの本文の重さがこの上限を入れる動機だった値より悪化した。実測 (いずれも
    // 64 KiB の本文の `JSON.stringify`): 平坦 0.19ms ／ 深さ 64 の櫛 1.37ms ／ 128 で 2.27ms ／
    // 256 で 3.70ms ／ 512 で 6.16ms ／ 2,999 で 33.4ms。**上限は「上限ちょうどの本文 1 通が
    // どれだけ焼けるか」をそのまま決める**ので、深さの上限はここで押さえる。
    // **この上限を上げる差分は、上の実測を取り直して理由を確認すること**
    expect(JSON_BODY_MAX_DEPTH).toBeLessThanOrEqual(128);
    // 実在のベンダー本文 (messages[].content[].source 等) は 5〜8 段、いちばん深い形でも
    // tools[].input_schema の JSON Schema で 30 段 (実測: 31 段で 422) なので、正当な本文は通る
    expect(JSON_BODY_MAX_DEPTH).toBeGreaterThanOrEqual(16);
    // 上限ちょうどの深さは実際に stringify できること (縛った値が RangeError の手前にあることの実測。
    // 閾値は呼び出し時点のスタック残量で動く = 実測 3,297〜4,164 ので、値ではなく挙動で固定する)
    expect(() => JSON.stringify(nestedArray(JSON_BODY_MAX_DEPTH))).not.toThrow();
  });
});
