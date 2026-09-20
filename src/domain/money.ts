// 金額 (マイクロ USD) の純粋ロジック。JSON では文字列で運び、DB では BIGINT で持つ (docs/spec.md §3)

// PostgreSQL BIGINT の最大値 (2^63 - 1)。19 桁でもこれを超える値は保存できない
export const MICRO_USD_MAX = 9_223_372_036_854_775_807n;
// 受け付ける文字列の形 (符号無し 10 進整数のみ。先頭 0 は許す)
const MICRO_USD_PATTERN = /^[0-9]{1,19}$/;

/**
 * JSON の文字列をマイクロ USD の BigInt へ変換する。
 * 形が違う・BIGINT の範囲を超えるときは null (呼び出し側が 422 にする)。
 */
export function parseMicroUsd(value: string): bigint | null {
  // 10 進の数字だけで 19 桁以内であること (正規表現は固定長なので ReDoS の余地は無い)
  if (!MICRO_USD_PATTERN.test(value)) return null;
  // BigInt に変換する (形は保証済みなので例外は出ない)
  const parsed = BigInt(value);
  // BIGINT の範囲内であること
  return parsed <= MICRO_USD_MAX ? parsed : null;
}

// USD の 10 進表記として受け付ける形 (符号無し・整数部 13 桁以内・小数部 6 桁以内)。
// 小数部を 6 桁に絞るのはマイクロ USD (100 万分の 1 USD) が持てる精度がそこまでだから。
// 7 桁目以降を四捨五入して受け取ると「公表単価と誤差 0」が静かに崩れるので、表せない値は拒否する。
// 整数部を 13 桁に絞るのは 13 + 6 = 19 桁が BIGINT の桁数の上限だから (値の上限は別途確認する)
const USD_DECIMAL_PATTERN = /^[0-9]{1,13}(?:\.[0-9]{1,6})?$/;
// マイクロ USD の小数点以下の桁数 (1 USD = 10^6 マイクロ USD)
const MICRO_USD_DIGITS = 6;

/**
 * USD の 10 進文字列 ("3" / "3.00" / "0.25") をマイクロ USD の BigInt へ変換する。
 * 形が違う・精度が足りない・BIGINT の範囲を超えるときは null (呼び出し側が拒否する)。
 * **浮動小数を経由しない**のが要点で、parseFloat を挟むと 0.1 + 0.2 の類の誤差が単価に混ざる。
 */
export function parseUsdDecimalToMicro(value: string): bigint | null {
  // 受け付ける形かどうかを先に見る (正規表現は固定長の繰り返しなので ReDoS の余地は無い)
  if (!USD_DECIMAL_PATTERN.test(value)) return null;
  // 小数点で整数部と小数部に分ける (小数点が無ければ小数部は空)
  const [whole, fraction = ''] = value.split('.');
  // 小数部をマイクロの桁数まで 0 で埋める ("25" → "250000")
  const padded = fraction.padEnd(MICRO_USD_DIGITS, '0');
  // 整数部をマイクロへ繰り上げてから小数部を足す (すべて BigInt なので誤差は出ない)
  const micro = BigInt(whole) * 10n ** BigInt(MICRO_USD_DIGITS) + BigInt(padded);
  // BIGINT の範囲に収まるときだけ返す
  return micro <= MICRO_USD_MAX ? micro : null;
}
