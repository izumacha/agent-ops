// ガードレールのしきい値判定。**「発火するか」の規則はここが唯一の真実の源**で、
// API 層 (入力検証)・評価の結線 (src/lib/guardrail/evaluate.ts)・テストがここを読む。
// DB・Next.js に依存しない純粋ロジックなので、境界値をユニットテストで全部固定できる (§11)。
import { RuleKind } from '@/domain/types';

// しきい値との比べ方。**種別によって向きが逆になる**のが要点で、
// コストとエラー率は「上回ったら悪い」、品質は「下回ったら悪い」
export const RuleComparison = {
  // しきい値を上回ったら発火 (コスト・エラー率)
  above: 'above',
  // しきい値を下回ったら発火 (品質)
  below: 'below',
} as const;
// RuleComparison の値の型
export type RuleComparison = (typeof RuleComparison)[keyof typeof RuleComparison];

// 種別ごとの比べ方の表。**`Record<RuleKind, …>` なので種別を足すと typecheck が落ちる** —
// 向きを決めずに種別を追加できてしまうと、品質の規則をコストに流用した誤判定が静かに入る
export const RULE_COMPARISON: Readonly<Record<RuleKind, RuleComparison>> = {
  // 期間内のコストがしきい値 (マイクロ USD) を超えたら発火
  [RuleKind.cost]: RuleComparison.above,
  // 期間内のエラー率がしきい値 (0〜1) を超えたら発火
  [RuleKind.error_rate]: RuleComparison.above,
  // 直近の評価の品質スコアがしきい値 (0〜1) を下回ったら発火
  [RuleKind.quality]: RuleComparison.below,
};

// しきい値として受け付ける範囲 (下限は含み、上限は含む)。入力検証とテストが同じここを読む
export interface ThresholdRange {
  min: number;
  max: number;
}

// 割合 (0〜1) で表す種別の上限。エラー率・品質スコアはどちらも 0〜1 の比率
const RATIO_MAX = 1;

// 種別ごとのしきい値の範囲。コストはマイクロ USD の整数なので上限は金額の上限に合わせる
export function thresholdRangeFor(kind: RuleKind, costMax: number): ThresholdRange {
  // コストだけは金額の上限まで、割合の 2 種は 0〜1
  return kind === RuleKind.cost ? { min: 0, max: costMax } : { min: 0, max: RATIO_MAX };
}

/** 集計窓 (開始は含み、終了は含まない半開区間)。日次集計の UsageWindow と同じ約束 */
export interface GuardrailWindow {
  start: Date;
  endExclusive: Date;
}

// 1 分のミリ秒数 (窓の長さの計算に使う)
const MILLIS_PER_MINUTE = 60 * 1000;

/**
 * 「いまから過去 windowMinutes 分」の集計窓を作る。
 * **終了は now を含まない**半開区間にして、日次集計 (`src/domain/usage-window.ts`) と約束を揃える
 * (境界の 1 件が両方の窓に入る・どちらにも入らない、という取りこぼしを作らないため)。
 */
export function guardrailWindow(now: Date, windowMinutes: number): GuardrailWindow {
  // 終了は呼び出し時刻そのもの (含まない)
  const endExclusive = new Date(now.getTime());
  // 開始はそこから窓の長さだけ戻した時刻 (含む)
  const start = new Date(endExclusive.getTime() - windowMinutes * MILLIS_PER_MINUTE);
  // 半開区間として返す
  return { start, endExclusive };
}

/** 窓の中で測った値。**種別をまたいで 1 つの型にする**ので、測り漏れが型で見える */
export interface GuardrailMeasurement {
  // 窓の中の呼び出し回数 (エラー率の分母)
  requests: number;
  // そのうち失敗した呼び出しの回数 (上流の HTTP ステータスが 400 以上)
  errorRequests: number;
  // 窓の中の料金の合計 (マイクロ USD)
  costMicroUsd: bigint;
  // 直近の「採点が成立した」評価実行で最も低い観点の平均スコア。
  // **測れていなければ null** — 採点 0 件のときに 0.0 を入れると「最低品質」と読んで誤発火する
  // (この不変条件は DB の CHECK 制約でも守っている。ADR-0009)
  worstQualityScore: number | null;
}

/** 品質を読む対象 (評価実行の 3 観点の平均。`src/domain/evaluation/scores.ts` の RunTotals の一部) */
export interface QualityScores {
  accuracy: number | null;
  safety: number | null;
  deviation: number | null;
}

/**
 * 評価実行から「品質」として読む 1 つの数値を決める。**3 観点のうち最も低いもの**を採る。
 *
 * 平均ではなく最小にするのは、1 観点だけが崩れた形 (正確性は保ったまま安全性が落ちた等) を
 * 他の観点が埋めて見えなくしないため。しきい値の列は 1 つなので、どれか 1 つでも割ったら
 * 発火する側に倒す (§9 fail-safe)。
 *
 * **1 観点でも null なら全体を null にする。** `scoredCases = 0` のときは 3 つとも null に
 * なる約束 (DB の CHECK 制約で守っている) なので実際には 3 つ揃って欠けるが、片方だけ欠けた
 * 行が将来現れたときに「残った観点だけで判定する」のは「測れた」と言えない。
 */
export function worstQualityScore(scores: QualityScores | null): number | null {
  // 評価実行そのものが無ければ測れていない
  if (scores === null) return null;
  // 3 観点を配列にする
  const values = [scores.accuracy, scores.safety, scores.deviation];
  // 1 つでも欠けていれば測れていない扱いにする
  if (values.some((value) => value === null)) return null;
  // 欠けが無いので数値として最小を採る
  return Math.min(...(values as number[]));
}

/** 発火したときに記録する実測値 (種別ごとに単位が違うので判別可能な共用体にする) */
export type RuleObservation =
  | { kind: typeof RuleKind.cost; costMicroUsd: bigint }
  | { kind: typeof RuleKind.error_rate; rate: number }
  | { kind: typeof RuleKind.quality; score: number };

/** 判定の結果 (発火したときだけ実測値が付く) */
export type RuleEvaluation = { fired: false } | { fired: true; observation: RuleObservation };

// 発火しなかったことを表す値 (毎回オブジェクトを作らない)
const NOT_FIRED: RuleEvaluation = { fired: false };

/**
 * 1 つのルールが発火するかを判定する。
 *
 * **測れていないものは発火させない (fail-safe)。** 「測れない」と「悪い」は別で、
 * 呼び出しが 0 件の窓をエラー率 0% とも 100% とも読めないし、採点 0 件の評価を
 * 「品質最低」と読むのは誤判定。測れないときに止めると、使われていないエージェントが
 * 勝手に suspended になる (UC-08 が止めたいのは「悪化したエージェント」)。
 */
export function evaluateRule(
  kind: RuleKind,
  threshold: number,
  measurement: GuardrailMeasurement,
): RuleEvaluation {
  // 種別ごとに測る対象と向きが違うので分岐する
  switch (kind) {
    case RuleKind.cost: {
      // 料金は BigInt と数値を直接比べる (JS の関係演算子は BigInt と Number を数学的に正しく比べる)
      if (!(measurement.costMicroUsd > threshold)) return NOT_FIRED;
      // 超過した料金を実測値として返す
      return { fired: true, observation: { kind, costMicroUsd: measurement.costMicroUsd } };
    }
    case RuleKind.error_rate: {
      // 呼び出しが 1 件も無い窓ではエラー率を定義できない (0/0。測れないので発火させない)
      if (measurement.requests <= 0) return NOT_FIRED;
      // 失敗の割合を求める
      const rate = measurement.errorRequests / measurement.requests;
      // しきい値を超えていなければ発火しない
      if (!(rate > threshold)) return NOT_FIRED;
      // 超過した割合を実測値として返す
      return { fired: true, observation: { kind, rate } };
    }
    case RuleKind.quality: {
      // 品質スコアを取り出す
      const score = measurement.worstQualityScore;
      // 測れていなければ発火しない (採点 0 件・評価を 1 度も走らせていない場合)
      if (score === null) return NOT_FIRED;
      // 品質だけは「下回ったら発火」
      if (!(score < threshold)) return NOT_FIRED;
      // 下回ったスコアを実測値として返す
      return { fired: true, observation: { kind, score } };
    }
  }
}
