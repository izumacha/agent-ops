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
