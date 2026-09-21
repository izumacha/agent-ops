// 料金計算 (src/domain/pricing.ts) の検査。**Step2 の受け入れ基準「料金計算の単体テストが
// ベンダー公表単価と誤差 0」がこれ**で、gate:step2 は正本の JSON からテスト名を導いて
// 「全モデル分が pass しているか」を確かめる (テスト名の接頭辞を変えるとゲートが落ちる)。
//
// 期待値は**実装の関数を使わず**、正本 JSON の 10 進文字列からテスト側で組み立てる。
// 実装を呼んで実装と比べると、単価の読み違いも端数の取り違えも一緒に動いて必ず緑になる。
import { describe, expect, it } from 'vitest';
import { costMicroUsd, findModelPrice, listModelPrices } from '@/domain/pricing';
import { MICRO_USD_MAX, parseUsdDecimalToMicro } from '@/domain/money';
import { Provider } from '@/domain/types';
import vendorPrices from '@/domain/pricing/vendor-prices.json';
// gate:step2 が照合するテスト名の接頭辞 (**正本から読む**。写しを持つと、食い違ったとき
// ゲートが赤くなるだけで原因が分かりにくい。§6 定数は単一の参照元に置く)
import { PRICE_TEST_PREFIX } from '../scripts/lib/step2-criteria.mjs';

// 単価の分母 (公表はすべて 100 万トークンあたり)
const UNIT = 1_000_000n;

// 正本 JSON の 1 行の形 (テスト側でも意味を与えて読む)
interface Entry {
  provider: string;
  model: string;
  inputUsdPerMillionTokens: string;
  outputUsdPerMillionTokens: string;
  source: string;
  retrievedAt: string;
}

// 正本の全行 (テストはここからケースを導く。一覧を手で書き写さない)
const ENTRIES = vendorPrices.models as Entry[];

// USD の 10 進文字列をマイクロ USD へ、**実装とは別の書き方で**変換する
// (実装は「整数部 × 10^6 + 小数部」、こちらは「文字列を連結して 1 つの整数として読む」)
function usdToMicro(text: string): bigint {
  // 小数点で分ける (小数点が無ければ小数部は空)
  const [whole, fraction = ''] = text.split('.');
  // 小数部が 6 桁を超えるとマイクロでは表せない (正本にそんな値を置かない、という約束もここで固定する)
  expect(fraction.length, `${text} の小数部が 6 桁を超えている`).toBeLessThanOrEqual(6);
  // 「整数部 + 6 桁に揃えた小数部」をそのまま 1 つの整数として読む
  return BigInt(`${whole}${fraction.padEnd(6, '0')}`);
}

// 期待する料金を求める (切り上げを「割った余りがあれば 1 足す」という別の書き方で表す)
function expectedCost(entry: Entry, inputTokens: number, outputTokens: number): bigint {
  // 入力ぶんの「単価 × トークン数」
  const input = usdToMicro(entry.inputUsdPerMillionTokens) * BigInt(inputTokens);
  // 出力ぶんの「単価 × トークン数」
  const output = usdToMicro(entry.outputUsdPerMillionTokens) * BigInt(outputTokens);
  // 100 万トークンあたりの尺度から実際の料金へ落とす
  const total = input + output;
  // 割り算の商と余り
  const quotient = total / UNIT;
  const rest = total % UNIT;
  // 余りがあれば切り上げる
  return rest === 0n ? quotient : quotient + 1n;
}

describe('単価表 (正本 JSON)', () => {
  it('1 件以上あり、実装が読んだ表と件数が一致する', () => {
    // 正本が空だと「全モデル未対応」になるので、空でないことを先に見る
    expect(ENTRIES.length).toBeGreaterThan(0);
    // 実装が読み飛ばした行が無いこと (読み飛ばしは「未対応モデル」に化けて原因が見えない)
    expect(listModelPrices()).toHaveLength(ENTRIES.length);
  });

  it.each(ENTRIES.map((entry) => [`${entry.provider} ${entry.model}`, entry] as const))(
    '%s は出典 URL と取得日を持つ',
    (_label, entry) => {
      // 出典は https の URL (人が値を確かめに行ける形)
      expect(entry.source).toMatch(/^https:\/\//);
      // 取得日は YYYY-MM-DD
      expect(entry.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    },
  );

  it.each(ENTRIES.map((entry) => [`${entry.provider} ${entry.model}`, entry] as const))(
    '%s の単価が正本のとおり読まれている',
    (_label, entry) => {
      // 実装が表から引いた単価
      const price = findModelPrice(entry.provider as Provider, entry.model);
      // 引けること (引けなければそのモデルは中継できない)
      expect(price).not.toBeNull();
      // 入力単価が正本と一致すること
      expect(price?.inputMicroUsdPerUnit).toBe(usdToMicro(entry.inputUsdPerMillionTokens));
      // 出力単価が正本と一致すること
      expect(price?.outputMicroUsdPerUnit).toBe(usdToMicro(entry.outputUsdPerMillionTokens));
    },
  );
});

describe('料金計算', () => {
  // 試すトークン数の組 (端数が出る値・大きい値・0 を混ぜる)。
  // 1_234_567 のような端数の出る値を入れるのが要点で、浮動小数を経由する実装はここで必ずずれる
  const TOKEN_CASES: readonly (readonly [number, number])[] = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1_000_000, 1_000_000],
    [1_234_567, 7_654_321],
    [999_999, 1],
    [123_456_789, 987_654_321],
  ];

  it.each(ENTRIES.map((entry) => [`${entry.provider} ${entry.model}`, entry] as const))(
    `${PRICE_TEST_PREFIX}%s は公表単価と誤差 0`,
    (_label, entry) => {
      // 上のすべてのトークン数の組で、正本から組み立てた期待値と一致すること
      for (const [inputTokens, outputTokens] of TOKEN_CASES) {
        // 実装が返す料金
        const actual = costMicroUsd(
          entry.provider as Provider,
          entry.model,
          inputTokens,
          outputTokens,
        );
        // 正本から独立に組み立てた期待値
        const expected = expectedCost(entry, inputTokens, outputTokens);
        // 1 マイクロ USD の違いも許さない
        expect(actual, `${entry.model} ${inputTokens}/${outputTokens}`).toBe(expected);
      }
    },
  );

  it('100 万トークンちょうどなら公表単価そのものになる (尺度の取り違えを落とす)', () => {
    // 正本の先頭の行を使う
    const entry = ENTRIES[0];
    // 入力 100 万トークンだけを使った呼び出し
    const actual = costMicroUsd(entry.provider as Provider, entry.model, 1_000_000, 0);
    // 公表単価 (100 万トークンあたり) をマイクロ USD にしたものと一致する
    expect(actual).toBe(usdToMicro(entry.inputUsdPerMillionTokens));
  });

  it('端数は切り上げる (1 トークンでも料金を 0 にしない)', () => {
    // 1 トークンの料金は必ず 1 マイクロ USD 未満だが、0 にはならない
    const entry = ENTRIES[0];
    // 入力 1 トークンだけ
    const actual = costMicroUsd(entry.provider as Provider, entry.model, 1, 0);
    // 切り上げなので 1 以上
    expect(actual).toBeGreaterThanOrEqual(1n);
    // かつ、切り上げた値ちょうど
    expect(actual).toBe(expectedCost(entry, 1, 0));
  });

  it('割り切れるときは切り上げない (切り上げが常に +1 になっていないこと)', () => {
    // 100 万トークンは必ず割り切れる
    const entry = ENTRIES[0];
    // 実装の値
    const actual = costMicroUsd(entry.provider as Provider, entry.model, 1_000_000, 0);
    // 公表単価ちょうど (+1 されていない)
    expect(actual).toBe(usdToMicro(entry.inputUsdPerMillionTokens));
  });

  it('表に無いモデルは null (計れない呼び出しを 0 円にしない)', () => {
    // 存在しないモデル名
    expect(costMicroUsd(Provider.anthropic, 'claude-unknown-model', 100, 100)).toBeNull();
  });

  it('プロバイダが違えば同じモデル名でも引けない', () => {
    // anthropic の行を openai として引く
    const entry = ENTRIES.find((row) => row.provider === Provider.anthropic);
    // 正本に anthropic の行がある前提 (無ければこの検査自体が成り立たない)
    expect(entry).toBeDefined();
    // プロバイダを取り違えた組み合わせは表に無い
    expect(findModelPrice(Provider.openai, entry?.model ?? '')).toBeNull();
  });

  it.each([
    ['負のトークン数', -1, 0],
    ['小数のトークン数', 1.5, 0],
    ['数でない値 (NaN)', Number.NaN, 0],
    ['安全な整数の範囲外', Number.MAX_SAFE_INTEGER + 2, 0],
    ['出力側が負', 0, -1],
  ])('%s は null (上流の申告値をそのまま信じない)', (_label, inputTokens, outputTokens) => {
    // 正本の先頭のモデルで試す
    const entry = ENTRIES[0];
    // 不正なトークン数はすべて null
    expect(
      costMicroUsd(entry.provider as Provider, entry.model, inputTokens, outputTokens),
    ).toBeNull();
  });
});

describe('USD 10 進文字列 → マイクロ USD', () => {
  it.each([
    ['整数のみ', '3', 3_000_000n],
    ['小数 2 桁', '3.00', 3_000_000n],
    ['小数 2 桁 (端数あり)', '1.25', 1_250_000n],
    ['小数 6 桁', '0.000001', 1n],
    ['0', '0', 0n],
  ])('%s を誤差なく変換する', (_label, text, expected) => {
    // 浮動小数を経由しないので、どの値も丸めずに表せる
    expect(parseUsdDecimalToMicro(text)).toBe(expected);
  });

  it.each([
    ['小数 7 桁 (マイクロで表せない)', '0.0000001'],
    ['指数表記', '1e6'],
    ['符号付き', '-1.00'],
    ['空文字', ''],
    ['小数点だけ', '.'],
    ['前後の空白', ' 1.00 '],
    ['桁数超過', '12345678901234'],
  ])('%s は受け付けない (静かに丸めない)', (_label, text) => {
    // 表せない・読めない値は null (呼び出し側が落とす)
    expect(parseUsdDecimalToMicro(text)).toBeNull();
  });

  it('BIGINT の範囲を超える単価は受け付けない', () => {
    // 形の検査 (整数部 13 桁まで) は通るが、マイクロへ 100 万倍すると BIGINT に収まらない値。
    // **形だけを見て範囲を見ない実装を落とす** — 範囲の検査を外すと、この値が
    // 9999999999999000000 という列へ書けない数として通り、保存の時点で初めて落ちる
    expect(parseUsdDecimalToMicro('9999999999999')).toBeNull();
    // 範囲に収まる側 (境界のすぐ内側) は通る
    expect(parseUsdDecimalToMicro('9223372036854.775807')).toBe(MICRO_USD_MAX);
  });
});
