// ダッシュボードの日時の見せ方（Step5）。
//
// **UTC の「分」までを出す。** 秒とミリ秒（`2026-10-04T08:02:24.428Z` の後ろ）は運用の判断に
// 使わないのに桁を取り、表の列を押し広げて肝心の理由の文を折り返させる（実測）。
//
// **タイムゾーンは列の見出しで 1 度だけ伝える**（値には `Z` を付けない）。値ごとに付けると
// 同じ情報を行数ぶん繰り返すことになり、付けないと「どこの時刻か」が読めなくなる。
// 保存されているのは UTC なので、変換せずそのまま出す（ブラウザのロケールで揺れない）。

// 日付と時刻の区切り（`YYYY-MM-DD HH:mm` の形にする）
const DATE_TIME_SEPARATOR = ' ';

/**
 * 日時を `YYYY-MM-DD HH:mm`（UTC）の形にする。
 * @param value 表示する日時
 * @returns 分までの文字列
 */
export function formatUtcMinute(value: Date): string {
  // ISO 8601 の文字列（必ず UTC で `YYYY-MM-DDTHH:mm:ss.sssZ` の形）
  const iso = value.toISOString();
  // 日付部分（T の手前）と時刻の「時:分」だけを取り出して繋ぐ
  return `${iso.slice(0, 10)}${DATE_TIME_SEPARATOR}${iso.slice(11, 16)}`;
}
