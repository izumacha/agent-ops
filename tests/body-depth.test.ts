// JSON 本文の入れ子の深さを縛る判定 (src/lib/api/body.ts の exceedsMaxDepth)。
//
// **なぜ要るか**: サイズの上限だけでは資源の消費を縛れない。`JSON.parse` は深さ 10 万でも通るのに
// `JSON.stringify` は約 4,164 で RangeError になり、しかも**落ちなくても深い構造の stringify 自体が
// 重い** (実測: 同じ 65 KiB で深い本文 9.56ms 対 平坦 0.70ms = 13.6 倍)。上限を置かないと、
// 有効なキー 1 本・本文 8.4 KiB で 1 リクエストあたり 7ms の CPU を焼けた。
// 判定そのものが深い入力でスタックを食っては意味が無いので、実装は再帰ではなく明示のスタック
import { describe, expect, it } from 'vitest';
import { exceedsMaxDepth } from '@/lib/api/body';
import { JSON_BODY_MAX_BYTES, JSON_BODY_MAX_DEPTH } from '@/lib/constants';

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

  it('配列の中のオブジェクトも数える (交互の入れ子)', () => {
    // **配列の枝とオブジェクトの枝を別々に書いたので、片方から他方へ辿り損ねる形が書ける** —
    // 実測で、配列の枝の条件を `typeof child === 'object'` から `Array.isArray(child)` へ
    // 取り違えると 808 件すべて緑（件数も不変）のまま `[{"a":[{"a":…}]}]` が素通りし、
    // 2,400 段の本文で `JSON.stringify` が RangeError → 500 になった
    let value: unknown = 1;
    for (let level = 0; level < JSON_BODY_MAX_DEPTH; level += 1) value = [{ a: value }];
    expect(exceedsMaxDepth(value, JSON_BODY_MAX_DEPTH)).toBe(true);
  });

  it.each([
    ['配列の末尾', (deep: unknown) => [0, 1, deep]],
    ['オブジェクトの 2 番目のキー', (deep: unknown) => ({ a: 1, b: deep })],
  ])('先頭以外に置かれた深い値も数える: %s', (_label, wrap) => {
    // **既存のケースは深い値が「配列の 0 番目・最初のキー」にしかなかった** — 実測で、
    // 子を辿るループを `current.node.slice(0, 1)` / `Object.keys(record).slice(0, 1)` に
    // 絞る変異はどちらも全件緑のまま通り、深い値を 2 番目以降に置いた本文が
    // 上限をすり抜けて `JSON.stringify` の RangeError（＝ 500）に戻った。
    let deep: unknown = 1;
    for (let level = 0; level < JSON_BODY_MAX_DEPTH; level += 1) deep = [deep];
    expect(exceedsMaxDepth(wrap(deep), JSON_BODY_MAX_DEPTH)).toBe(true);
  });

  it.each(['__proto__', 'constructor', 'prototype', 'messages'])(
    '特定のキーを読み飛ばさない: %s',
    (key) => {
      // `JSON.parse` は `__proto__` を**自分のキー**として作る（プロトタイプは差し替わらない）ので、
      // 辿る側も普通のキーとして扱う。**実測で、オブジェクトの枝に
      // `if (key === '__proto__') continue;`（汚染対策としていかにも書かれそうな 1 行）を足すと
      // 808 件すべて緑・件数も不変のまま、この形だけが上限をすり抜けて 4,000 段が中継され、
      // 4,600 段は 500 になった**。`constructor` / `prototype` は同じ反射がまず名指しする綴り、
      // `messages` は実在の本文の主要キーで、どれも「1 つだけ飛ばす」変異が書ける場所
      const opening = `{${JSON.stringify(key)}:`;
      const inner = `${opening.repeat(JSON_BODY_MAX_DEPTH)}1${'}'.repeat(JSON_BODY_MAX_DEPTH)}`;
      expect(exceedsMaxDepth(JSON.parse(`{"x":${inner}}`), JSON_BODY_MAX_DEPTH)).toBe(true);
    },
  );

  // 上限を 1 段超える深さの鎖 (これを本文のどこに置いても true になるはず)
  const overLimitChain = `${'['.repeat(JSON_BODY_MAX_DEPTH + 1)}1${']'.repeat(JSON_BODY_MAX_DEPTH + 1)}`;

  /**
   * 本文の上限 (`JSON_BODY_MAX_BYTES`) いっぱいまで同じ断片を並べる。
   * **個数を定数で書かない** — 攻撃者が届く上限はバイト数だけが決めるので、そこから導く
   * @param piece 並べる断片を作る関数 (通し番号を受け取る)
   * @param reserved 断片以外に使うバイト数
   * @returns 並べた断片
   */
  function fillToLimit(piece: (index: number) => string, reserved: number): string {
    // 並べた断片
    const parts: string[] = [];
    // ここまでに使ったバイト数
    let used = reserved;
    // 上限を超える手前まで足し続ける
    for (let index = 0; ; index += 1) {
      // 次の断片
      const next = piece(index);
      // 入らなくなったら終わり
      if (used + next.length > JSON_BODY_MAX_BYTES) break;
      parts.push(next);
      used += next.length;
    }
    // つなげて返す
    return parts.join('');
  }

  it.each([
    [
      '配列の届きうる最後の位置 (先頭でも末尾でもない)',
      () => `[${fillToLimit(() => '0,', overLimitChain.length + 4)}${overLimitChain},0]`,
    ],
    [
      'オブジェクトの届きうる最後のキー (先頭でも末尾でもない)',
      () =>
        `{${fillToLimit((i) => `"a${i}":0,`, overLimitChain.length + 18)}"deep":${overLimitChain},"z":0}`,
    ],
    [
      '幅の広い枝をすべて辿り終えてから見る深い値',
      () => `[${overLimitChain}${fillToLimit(() => ',[]', overLimitChain.length + 2)}]`,
    ],
  ])('本文の上限いっぱいに広げても深い値を数える: %s', (_label, build) => {
    // **位置や個数を定数で試すだけでは「打ち切り」という族は閉じない。** `slice(0, 100)` を
    // 塞いでも `slice(0, 25_000)`、訪問回数の予算 10,000 を塞いでも 20,200、という具合に
    // しきい値を 1 つ動かすだけで復活し、どれも 64 KiB 以内の本文で上限を素通りできた（実測）。
    // **しきい値の天井は「本文の上限に何個詰められるか」だけが決める**ので、そこまで届く
    // フィクスチャを置けば族ごと閉じる — これより大きいしきい値は**定義上悪用できない**
    // （本文をそこまで大きくできないため）。3 つの形はそれぞれ別の族を担当する:
    // 位置の打ち切り（先頭でも末尾でもない最後の位置に置く）、キーの打ち切り、
    // 訪問回数・スタック長の予算（辿る順は後入れ先出しなので、深い枝を先頭に置くと最後に見る）
    const text = build();
    // 実際に届く本文であること (上限を超えていたら攻撃に使えないので検査の意味が無い)
    expect(text.length).toBeLessThanOrEqual(JSON_BODY_MAX_BYTES);
    expect(exceedsMaxDepth(JSON.parse(text), JSON_BODY_MAX_DEPTH)).toBe(true);
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
    // **下限も縛る。** 実在のベンダー本文は画像つき `messages` で 6〜8 段、`tools` や
    // `response_format` を含む形で 11〜12 段。上限を下げる差分は「安全側だから」と通りやすいが、
    // 下げすぎると正当な本文を 422 にする（実測で 16 まで下げても 808 件すべて緑で、
    // そのとき通るツール定義の JSON Schema は 6 段まで落ちた）。実在の最深に 4 倍の余裕を残す
    expect(JSON_BODY_MAX_DEPTH).toBeGreaterThanOrEqual(48);
    // 上限ちょうどの深さは実際に stringify できること (縛った値が RangeError の手前にあることの実測。
    // 閾値は呼び出し時点のスタック残量で動く = 実測 3,297〜4,164 ので、値ではなく挙動で固定する)
    expect(() => JSON.stringify(nestedArray(JSON_BODY_MAX_DEPTH))).not.toThrow();
  });
});
