// 発火の要約文（`Incident.summary` と通知本文に使う 1 行）の組み立て。
//
// **文言をここ 1 か所に集める**のは §6 の一元管理で、インシデント一覧の表示・通知の本文・
// 監査ログを読む人がすべて同じ文を見るようにするため。種別ごとに単位が違う（マイクロ USD /
// 割合 / スコア）ので、数値の見せ方もここで決める。
//
// **実測値としきい値だけを書き、利用者の入力や上流の応答は 1 文字も混ぜない。** この文は
// インシデントの行として保存され、通知として外部の受け手へも送られるので、機微情報が入ると
// 2 か所へ同時に漏れる（§9）。
import { RuleKind } from '@/domain/types';
import { RULE_KIND_LABELS } from '@/lib/constants';
import type { RuleObservation } from '@/domain/guardrail/rule';

// 割合を百分率で見せるときの小数の桁数（45.3% のように 1 桁まで）
const PERCENT_FRACTION_DIGITS = 1;
// 品質スコアを見せるときの小数の桁数（0〜1 の値なので 2 桁）
const SCORE_FRACTION_DIGITS = 2;
// 百分率へ直す倍率
const PERCENT_SCALE = 100;

// 割合（0〜1）を「45.3%」の形にする
function formatPercent(rate: number): string {
  // 100 倍して小数 1 桁に丸め、% を付ける
  return `${(rate * PERCENT_SCALE).toFixed(PERCENT_FRACTION_DIGITS)}%`;
}

/**
 * 発火した理由を 1 行の日本語にする。
 *
 * @param observation 発火したときの実測値（種別ごとに単位が違う判別可能な共用体）
 * @param threshold そのルールのしきい値
 * @param windowMinutes 集計窓の長さ（分）。**どの種別も文に出す** — 品質も窓の中の評価実行だけを
 *   見るので、出さないと「1 分の窓を見たのか 7 日の窓を見たのか」が記録から読めない
 */
export function guardrailIncidentSummary(
  observation: RuleObservation,
  threshold: number,
  windowMinutes: number,
): string {
  // 種別の日本語ラベル（「コスト超過」など）
  const label = RULE_KIND_LABELS[observation.kind];
  // 種別ごとに単位と向きが違うので文を分ける
  switch (observation.kind) {
    case RuleKind.cost:
      // 料金はマイクロ USD の整数のまま見せる（丸めると請求の根拠と食い違う）
      return `${label}: 直近 ${windowMinutes} 分の料金 ${observation.costMicroUsd} マイクロ USD がしきい値 ${threshold} を超えました`;
    case RuleKind.error_rate:
      // エラー率は百分率で見せる（0.453 より 45.3% のほうが読み取りやすい）
      return `${label}: 直近 ${windowMinutes} 分の失敗率 ${formatPercent(observation.rate)} がしきい値 ${formatPercent(threshold)} を超えました`;
    case RuleKind.quality:
      // 品質は「下回ったら発火」なので文も下回った側で書く。**窓も出す** —
      // 見たのは「窓の中の最新の評価」なので、窓を伏せると判断の根拠が読めない
      return `${label}: 直近 ${windowMinutes} 分の評価の最低スコア ${observation.score.toFixed(SCORE_FRACTION_DIGITS)} がしきい値 ${threshold.toFixed(SCORE_FRACTION_DIGITS)} を下回りました`;
  }
}
