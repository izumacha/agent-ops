// PostgreSQL の `BIGINT`（符号付き 64 ビット整数）が取りうる範囲と、その範囲へ収める変換。
// **定数と純粋関数だけを持ち、import を 1 つも持たない**（クライアントのバンドルへ入っても
// 問題にならない形に保つ。`src/lib/body-limits.ts` が `next.config.ts` のためにしているのと同じ）。
//
// **なぜ 1 か所に集めるか**: この上限は「金額（マイクロ USD）」と「監査ログの連番」という
// 無関係な 2 つの列で同じ値を要求する。別々に literal を書くと、同じ事実の写しが 2 つになり
// （§6 の一元管理）、片方だけを直したときにもう片方が静かに取り残される。

/** `BIGINT` の最大値 (2^63 - 1)。列の型が決める上限なので、用途によらずこの 1 つ。 */
export const PG_BIGINT_MAX = 9_223_372_036_854_775_807n;

/** 上限を 10 進で書いたときの桁数（19）。長すぎる入力を変換の前に落とすために使う。 */
export const PG_BIGINT_MAX_DIGITS = PG_BIGINT_MAX.toString().length;

// 受け付ける文字列の形（符号無し 10 進整数のみ。先頭 0 は許す）。
// **桁数の上限は `BigInt()` へ渡す前に落とすためのもの**で、何万桁もある数字列を変換してから
// 捨てる形にしないための門（§9 のリソース枯渇対策）。
// **残る境界**: この門が外れても結果は値の比較と同じ `null` なので、挙動からは区別できない
// （費用のための門であって、正しさはこの後の比較が担保している）。
const PG_BIGINT_PATTERN = new RegExp(`^[0-9]{1,${PG_BIGINT_MAX_DIGITS}}$`);

/**
 * 10 進の文字列を `BIGINT` に収まる BigInt へ変換する。
 * 形が違う・範囲を超えるときは `null`（呼び出し側が 422 にする）。
 *
 * **JSON の数値で受けてはいけない**値のための関数。倍精度では 2^53 を超えた時点で
 * 別の値に化けるので、API はこの手の値を文字列で運び、ここで BigInt へ直す。
 */
export function parsePgBigint(value: string): bigint | null {
  // 10 進の数字だけで桁数の上限以内であること（正規表現は固定長なので ReDoS の余地は無い）
  if (!PG_BIGINT_PATTERN.test(value)) return null;
  // BigInt に変換する（形は保証済みなので例外は出ない）
  const parsed = BigInt(value);
  // 値そのものが範囲内であること（桁数が収まっていても上限は超えうる）
  return parsed <= PG_BIGINT_MAX ? parsed : null;
}
