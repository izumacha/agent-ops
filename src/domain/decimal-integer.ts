// 10 進の整数だけを受け付ける文字列 → 数値の変換 (API の limit と CLI の --days が同じ規則を使う)。
// Number() / z.coerce.number() は 0x10 / 1e2 / +5 / ' 5 ' も通り、OpenAPI の type: integer より受理集合が広い。
// 桁数はどの用途の上限値 (limit 200 / days 365) より十分大きい 6 桁までに固定する

// 受け付ける桁数の上限
export const DECIMAL_INTEGER_MAX_DIGITS = 6;

// 10 進の数字だけで 1〜上限桁の文字列
const DECIMAL_INTEGER_PATTERN = new RegExp(`^[0-9]{1,${DECIMAL_INTEGER_MAX_DIGITS}}$`);

/**
 * 10 進の整数の文字列を数値へ変換する。数字以外・空・桁数超過は null (fail-closed)
 */
export function parseDecimalInteger(text: string): number | null {
  // 形が違えば受け付けない
  if (!DECIMAL_INTEGER_PATTERN.test(text)) return null;
  // 数字だけなので Number で安全に変換できる (先頭の 0 は 10 進として読む)
  return Number(text);
}
