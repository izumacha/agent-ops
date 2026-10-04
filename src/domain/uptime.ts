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
