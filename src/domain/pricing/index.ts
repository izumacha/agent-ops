// 料金計算の純粋ロジック。**単価の正本は同じディレクトリの vendor-prices.json**（ベンダーの公表値の写しと
// その出典 URL・取得日）で、このモジュールはそれを読んで整数演算するだけ。値をここへ書き写さない。
//
// **なぜ JSON をコードの隣に置くか**: この表は「ドキュメント」ではなく実行時に読む設定で、プロキシが
// 中継するたびに参照する。docs/ に置くと Next.js のバンドルがリポジトリのルートを跨いで拾うことになり、
// 配備物に入る保証も無くなる。人が読むための出典と取得日は各行が持っているので、正本としての役割は変わらない。
//
// **すべて BigInt で計算する**。受け入れ基準が「ベンダー公表単価と誤差 0」なので、途中に number を挟まない
// (1M トークンあたりの単価を 10^6 で割る計算は、浮動小数だと 0.30000000000000004 の類の誤差が必ず出る)。
import { Provider } from '@/domain/types';
import { parseUsdDecimalToMicro } from '@/domain/money';
import vendorPrices from './vendor-prices.json';

// 単価が「何トークンあたり」かの分母 (ベンダーの公表がすべて 100 万トークンあたりなので、その 100 万)
export const TOKENS_PER_PRICE_UNIT = 1_000_000n;

/** 1 モデル分の単価 (マイクロ USD / 100 万トークン) と、その出典 */
export interface ModelPrice {
  // どのプロバイダのモデルか
  provider: Provider;
  // モデル名 (プロキシの本文で指定される値と同じ綴り)
  model: string;
  // 入力 100 万トークンあたりのマイクロ USD
  inputMicroUsdPerUnit: bigint;
  // 出力 100 万トークンあたりのマイクロ USD
  outputMicroUsdPerUnit: bigint;
  // 公表ページの URL (人が値を確かめる入口)
  source: string;
  // その URL を確認した日 (YYYY-MM-DD)
  retrievedAt: string;
}

// JSON から読んだ 1 行の形 (resolveJsonModule が付ける型は string なので、ここで意味を与える)
interface VendorPriceEntry {
  provider: string;
  model: string;
  inputUsdPerMillionTokens: string;
  outputUsdPerMillionTokens: string;
  source: string;
  retrievedAt: string;
}

// 出典として受け付ける URL の形 (https のみ。http や相対パスを書けると「確かめに行けない出典」になる)
const SOURCE_URL_PATTERN = /^https:\/\/[^\s]+$/;
// 取得日として受け付ける形 (YYYY-MM-DD)
const RETRIEVED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// 表の引き方を 1 か所に決める (provider と model を 1 つの鍵にまとめる)
function priceKey(provider: Provider, model: string): string {
  // プロバイダが違えば同じモデル名でも別の単価なので、必ず両方を鍵に入れる
  return `${provider}\u0000${model}`;
}

// JSON の 1 行を ModelPrice に変換する。**壊れていれば例外で落とす (fail-closed)** —
// 黙って読み飛ばすと、その行のモデルが「未対応」に化けて中継だけが拒否され、原因が表に現れない
function toModelPrice(entry: VendorPriceEntry): ModelPrice {
  // プロバイダが正準の enum に無ければ落とす
  if (!Object.hasOwn(Provider, entry.provider)) {
    throw new Error(`vendor-prices.json: 未知のプロバイダ ${entry.provider}`);
  }
  // モデル名が空なら引けないので落とす
  if (entry.model.length === 0) {
    throw new Error('vendor-prices.json: モデル名が空です');
  }
  // 入力単価を 10 進文字列からマイクロ USD へ (表せない値は null で返る)
  const input = parseUsdDecimalToMicro(entry.inputUsdPerMillionTokens);
  // 出力単価も同じ規則で変換する
  const output = parseUsdDecimalToMicro(entry.outputUsdPerMillionTokens);
  // どちらかが読めなければ単価として使えないので落とす
  if (input === null || output === null) {
    throw new Error(`vendor-prices.json: 単価を読めません (${entry.provider} ${entry.model})`);
  }
  // 出典が無い・確かめに行けない形なら落とす (写しが独り歩きしないようにする)
  if (!SOURCE_URL_PATTERN.test(entry.source)) {
    throw new Error(`vendor-prices.json: 出典 URL が不正です (${entry.provider} ${entry.model})`);
  }
  // 取得日が無い・形が違えば落とす (いつの単価か分からない写しを許さない)
  if (!RETRIEVED_AT_PATTERN.test(entry.retrievedAt)) {
    throw new Error(`vendor-prices.json: 取得日が不正です (${entry.provider} ${entry.model})`);
  }
  // ここまで通った行だけを単価として採用する
  return {
    provider: entry.provider as Provider,
    model: entry.model,
    inputMicroUsdPerUnit: input,
    outputMicroUsdPerUnit: output,
    source: entry.source,
    retrievedAt: entry.retrievedAt,
  };
}

// JSON 全体を読んで鍵付きの表にする (モジュールの評価時に 1 度だけ走る)
function buildPriceTable(): ReadonlyMap<string, ModelPrice> {
  // 変換結果を入れる表
  const table = new Map<string, ModelPrice>();
  // JSON の models 配列を 1 行ずつ変換する
  for (const entry of vendorPrices.models as VendorPriceEntry[]) {
    // 壊れた行はここで例外になる
    const price = toModelPrice(entry);
    // 同じ (プロバイダ, モデル) が 2 行あると、どちらが効くかが並び順で決まってしまうので落とす
    const key = priceKey(price.provider, price.model);
    if (table.has(key)) {
      throw new Error(
        `vendor-prices.json: 単価が重複しています (${price.provider} ${price.model})`,
      );
    }
    // 表に入れる
    table.set(key, price);
  }
  // 1 行も無い表は「全モデルが未対応」を意味するので、設定ミスとして落とす
  if (table.size === 0) throw new Error('vendor-prices.json: 単価が 1 件もありません');
  // 読み取り専用として返す
  return table;
}

// 単価表 (このモジュールの唯一の状態。評価時に固定される)
const PRICE_TABLE = buildPriceTable();

/** 単価表に載っている全モデル (テストと、将来の「対応モデル一覧」API のための読み取り口) */
export function listModelPrices(): readonly ModelPrice[] {
  // 表の値を配列にして返す (Map 自体は外へ出さない)
  return [...PRICE_TABLE.values()];
}

/** (プロバイダ, モデル) の単価を引く。表に無ければ null (未対応モデル = 計れない呼び出し) */
export function findModelPrice(provider: Provider, model: string): ModelPrice | null {
  // 鍵を組み立てて表を引く (無ければ undefined)
  return PRICE_TABLE.get(priceKey(provider, model)) ?? null;
}

// トークン数として受け付ける値かどうか (負・小数・NaN・安全な整数の範囲外は受け付けない)
function isTokenCount(value: number): boolean {
  // 0 以上の安全な整数だけを通す (上流の申告値をそのまま信じないための fail-closed)
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * 1 回の呼び出しの料金をマイクロ USD で求める。表に無いモデル・不正なトークン数は null。
 * 端数は**切り上げ** — 1 トークンでも使った呼び出しの料金が 0 になると、
 * 安い呼び出しを大量に流すほど請求から漏れる (Step4 のコスト超過ルールも同じ分だけ鈍る)。
 */
export function costMicroUsd(
  provider: Provider,
  model: string,
  inputTokens: number,
  outputTokens: number,
): bigint | null {
  // 単価を引く (未対応モデルはここで null)
  const price = findModelPrice(provider, model);
  if (price === null) return null;
  // トークン数が数として妥当かを見る
  if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens)) return null;
  // 入力・出力それぞれの「単価 × トークン数」を足す (ここまでは 100 万トークンあたりの尺度)
  const scaled =
    price.inputMicroUsdPerUnit * BigInt(inputTokens) +
    price.outputMicroUsdPerUnit * BigInt(outputTokens);
  // 100 万で割って実際の料金にする。切り上げるために (分子 + 分母 - 1) / 分母 とする
  return (scaled + TOKENS_PER_PRICE_UNIT - 1n) / TOKENS_PER_PRICE_UNIT;
}
