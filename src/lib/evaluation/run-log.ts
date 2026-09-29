// 1 回の評価実行のあいだ、同じ種類のログを**最初の 1 回だけ**通す門。
//
// なぜ要るか: 評価は 1 リクエストでケース数ぶん (最大 EVALUATION_SET_MAX_CASES = 200 回) の
// 上流呼び出しを回す。上流が壊れているときは 200 件すべてが同じ理由で失敗するので、
// ケースごとに 1 行ずつ書くと 1 リクエストで 200 行が積まれ、しかも execute 権限があれば
// 何度でも繰り返せる。本物の異常がその中に埋もれる。
// プロキシ経路も同じ理由で「安く量産できる失敗」のログを落としている
// (src/app/api/v1/proxy/proxy-route.ts の 4xx でトークン数のログを出さない判断)。
//
// **情報は捨てない。** ケースごとの結末は EvaluationResult.excludedReason として DB に残り、
// `GET /evaluations/{runId}` から読める。ログが足すのは「除外理由だけでは分からない内訳」
// (2xx 以外だったのか、JSON として読めなかったのか、例外だったのか) で、それは
// 1 実行につき 1 回出れば足りる。
//
// **ログの文面そのものはここへ持ってこない。** `console` の実引数は「出してよい形」
// (文字列リテラル等) に絞ってあるため (tests/error-logging.test.ts)、この門は
// 「出してよいか」を真偽値で答えるだけにして、`console.error('…')` は呼び出し側に literal で残す。

/** 同じ種類のログを 1 実行につき 1 回だけ通す門 */
export interface RunLogGate {
  /** その種類のログを出してよいか (同じ種類の 2 回目以降は false) */
  first(kind: string): boolean;
}

// 門を作る (1 回の評価実行につき 1 つ。種類ごとに最初の 1 回だけ true を返す)
export function createRunLogGate(): RunLogGate {
  // すでに出した種類
  const seen = new Set<string>();
  // 種類ごとに最初の 1 回だけ true を返す
  return {
    first(kind: string): boolean {
      // すでに出していれば通さない
      if (seen.has(kind)) return false;
      // 初めてなので記録して通す
      seen.add(kind);
      return true;
    },
  };
}

// 門を渡されなかったときの既定 (常に通す)。単体テストや将来の直接呼び出しが
// 「門を渡さないと何も出なくなる」形にならないよう、既定は今までどおりにする
export const ALWAYS_LOG: RunLogGate = { first: () => true };
