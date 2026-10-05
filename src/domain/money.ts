// 金額 (マイクロ USD) の純粋ロジック。JSON では文字列で運び、DB では BIGINT で持つ (docs/spec.md §3)
import { PG_BIGINT_MAX, parsePgBigint } from './pg-bigint';

// 保存できる上限。**値は列の型 (BIGINT) が決めるので、その 1 か所から導く** —
// 同じ literal を書くと「マイクロ USD の上限」と「BIGINT の上限」の写しが 2 つになる (§6)
export const MICRO_USD_MAX = PG_BIGINT_MAX;

/**
 * JSON の文字列をマイクロ USD の BigInt へ変換する。
 * 形が違う・BIGINT の範囲を超えるときは null (呼び出し側が 422 にする)。
 *
 * **判定は `parsePgBigint` と同じ** (桁数 → BigInt → 値の上限)。マイクロ USD 固有の規則は
 * 無く、違うのは呼び出し側が出す文言だけなので、共有の変換をそのまま使う。
 */
export const parseMicroUsd = parsePgBigint;

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

/**
 * マイクロ USD を人が読む USD の文字列へ整形する（画面と CSV が使う）。
 *
 * **BigInt のまま整数演算で桁を分ける。** `Number()` を挟むと 2^53 を超える額で桁が落ち、
 * 「請求の根拠」として使えない値になる（料金計算を全部 BigInt でやっているのと同じ理由）。
 *
 * 末尾の 0 は落とすが**小数 2 桁は必ず残す**（`1.5` ではなく `1.50`。金額として読みやすく、
 * 表の桁もそろう）。1 回の中継は 1 USD に満たないことが多いので、有効な桁は 6 桁まで残す。
 */
export function formatMicroUsdAsUsd(micro: bigint): string {
  // 符号を分けて絶対値で桁を組む (負の額は想定しないが、表示で壊れないようにする)
  const negative = micro < 0n;
  const absolute = negative ? -micro : micro;
  // マイクロの 1 USD 分
  const scale = 10n ** BigInt(MICRO_USD_DIGITS);
  // 整数部と小数部に分ける
  const whole = absolute / scale;
  const fraction = absolute % scale;
  // 小数部を 6 桁の文字列にする (足りない桁は先頭を 0 で埋める)
  let fractionText = fraction.toString().padStart(MICRO_USD_DIGITS, '0');
  // 末尾の 0 を落とす (0.250000 → 0.25)
  fractionText = fractionText.replace(/0+$/, '');
  // 2 桁は必ず残す (0.2 → 0.20 / 0 → 0.00)
  while (fractionText.length < 2) fractionText += '0';
  // 符号を戻して組み立てる
  return `${negative ? '-' : ''}${whole.toString()}.${fractionText}`;
}
