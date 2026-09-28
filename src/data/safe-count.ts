// 集計 SQL が返す BIGINT を、JSON で運べる数値へ写すための純粋関数。
//
// アダプタの中に埋めていたときは**どのテストからも呼ばれていなかった** — 上限の判定を消しても、
// 負の値を通しても全件緑のまま通る (実測)。境界の挙動を固定できるようこちらへ出してある。
// 金額 (costMicroUsd) はここを通さない — あちらは BigInt のまま Port の型で運ぶ (桁を落とさないため)。

/**
 * BIGINT の集計値を number へ写す。**表せない値は落とす (fail-closed)**。
 * Number へ丸めて返すと請求や上限の判定が静かにずれるので、
 * 「1 日に 9 千兆トークン」のような現実には起きない値でも、黙って間違えるより落ちるほうを選ぶ。
 * @param value 集計 SQL が返した値
 * @param label 失敗時のメッセージに出す項目名 (どの列が壊れたか分かるように)
 */
export function toSafeCount(value: bigint, label: string): number {
  // 安全な整数の上限を超えていたら、その場で気付けるように投げる
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`日次集計の ${label} が数値として表せる範囲を超えました`);
  }
  // 回数・トークン数は 0 以上しか取り得ない。負なら集計か列の意味が壊れているので同じく落とす
  // (上限だけを見ると、符号を取り違えた SQL の結果が「マイナスの利用量」として素通りする)
  if (value < 0n) {
    throw new Error(`日次集計の ${label} が負の値になりました`);
  }
  // 範囲内なので数値へ落とす
  return Number(value);
}
