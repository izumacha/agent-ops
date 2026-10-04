// 稼働率の計算 (ダッシュボード Step5)。Prisma / Next 非依存の純粋関数。
//
// **定義**: 期間内の呼び出しのうち、上流の HTTP ステータスが 400 未満だった割合。
// 失敗の下限は `USAGE_ERROR_STATUS_FLOOR`（ガードレールのエラー率と同じ値）を使い、
// 2 つの画面・2 つのアダプタで数え方が割れないようにする。
//
// **呼び出しが 0 件の期間は `null`（0% と読まない）。** Step4 の「測れていないものは
// 発火させない」と同じ流儀で、まだ 1 度も呼ばれていないエージェントを「稼働率 0%」と
// 表示すると、運用者は障害が起きていると読む。
import { USAGE_ERROR_STATUS_FLOOR } from '@/domain/guardrail/rule';

// 失敗とみなす HTTP ステータスの下限を、稼働率の文脈の名前でも公開する
// (ガードレールのエラー率と同じ値であることを呼び出し側が確認できるようにする)
export const UPTIME_ERROR_STATUS_FLOOR = USAGE_ERROR_STATUS_FLOOR;

/**
 * 稼働率を 0〜1 の割合で返す。測れないときは `null`。
 *
 * 丸めない（表示の桁は画面側が決める）。`requests` と `errorRequests` は
 * **同じクエリで取った対**であることが前提で、食い違う組み合わせ（負の値・分子が分母を超える）は
 * データが壊れているので `null` に倒す（fail-safe。嘘の百分率を出すより「測れない」と言う）。
 */
export function uptimeRate(requests: number, errorRequests: number): number | null {
  // 整数でない・有限でない値は測れないものとして扱う
  if (!Number.isInteger(requests) || !Number.isInteger(errorRequests)) return null;
  // 呼び出しが 1 件も無ければ測れない (0% ではない)
  if (requests <= 0) return null;
  // 分子が負・分母を超えるのは対が壊れている状態なので測れないものとして扱う
  if (errorRequests < 0 || errorRequests > requests) return null;
  // 成功した件数の割合を返す
  return (requests - errorRequests) / requests;
}

// 百分率にするときの小数の桁数（画面と CSV がこの 1 つの定義を共有する）
const UPTIME_PERCENT_FRACTION_DIGITS = 1;

/**
 * 稼働率（0〜1）を**百分率の数字**にする（`0.6667` → `'66.7'`）。
 *
 * **単位の記号は付けない。** 画面は後ろに `%` を足して出し、CSV は列の見出しに単位を書いて
 * 数字だけを入れる（表計算で合計や並べ替えができる形にするため）。
 * **桁を 1 か所で決めるのが要点** — 画面が百分率・CSV が 0〜1 の割合という食い違いがあると、
 * 同じ見出しの列を突き合わせた運用者が稼働率を 100 分の 1 に読み違える（実測で
 * 画面「66.7%」・CSV「0.6667」が同じ `稼働率` の列に出ていた）。
 */
export function formatUptimePercent(rate: number): string {
  // 100 倍して決めた桁で丸める（丸めるのは表示の都合。集計側は丸めない）
  return (rate * 100).toFixed(UPTIME_PERCENT_FRACTION_DIGITS);
}
