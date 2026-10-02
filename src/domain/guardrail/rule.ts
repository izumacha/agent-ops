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
 * 集計窓の長さとして受け付けられる値かを判定する。**入力検証・DB の CHECK 制約・
 * 窓の組み立てがこの 1 つの述語を共有する** (上限の写しを作らない)。
 *
 * 範囲外を弾くのは fail-open を防ぐため: 0 分の窓は幅ゼロの半開区間になって 1 件も拾わないので、
 * 呼び出し回数 0・料金 0 と測れて**どの種別も永久に発火しない**（止めるべき状況で止まらない）。
 * 負の値は start が end より後になって同じ結果になり、NaN は Invalid Date になって
 * 入力検証ではなくクエリの境界で落ちる。
 */
export function isValidWindowMinutes(windowMinutes: number, min: number, max: number): boolean {
  // 整数でなければ受け付けない (小数の分は DB の Int 列に入らない)
  if (!Number.isInteger(windowMinutes)) return false;
  // 下限と上限の内側であること
  return windowMinutes >= min && windowMinutes <= max;
}

/**
 * 「いまから過去 windowMinutes 分」の集計窓を作る。範囲外の長さなら **null**。
 * **終了は now を含まない**半開区間にして、日次集計 (`src/domain/usage-window.ts`) と約束を揃える
 * (境界の 1 件が両方の窓に入る・どちらにも入らない、という取りこぼしを作らないため)。
 */
export function guardrailWindow(
  now: Date,
  windowMinutes: number,
  min: number,
  max: number,
): GuardrailWindow | null {
  // 範囲外の長さでは窓を作らない (呼び出し側が「判定できない」として扱う)
  if (!isValidWindowMinutes(windowMinutes, min, max)) return null;
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
 * 窓の中で「その種別が測った値」を取り出す。**測れていなければ null。**
 *
 * 「測れない」と「悪い」は別。呼び出しが 0 件の窓をエラー率 0% とも 100% とも読めないし、
 * 採点 0 件の評価を「品質最低」と読むのは誤判定。測れないときに止めると、使われていない
 * エージェントが勝手に suspended になる (UC-08 が止めたいのは「悪化したエージェント」)。
 */
function observe(kind: RuleKind, measurement: GuardrailMeasurement): RuleObservation | null {
  // 種別ごとに測る対象が違うので分岐する
  switch (kind) {
    case RuleKind.cost:
      // 料金の合計は常に測れている (0 円も「0 円だった」という測定結果)
      return { kind, costMicroUsd: measurement.costMicroUsd };
    case RuleKind.error_rate:
      // 呼び出しが 1 件も無い窓ではエラー率を定義できない (0/0)。
      // **分母が 0 のまま割らない**のが要点 — `3 / 0` は Infinity になり、
      // どんなしきい値でも必ず発火する (集計の分母と分子の整合が崩れたときに全件停止する)
      return measurement.requests <= 0
        ? null
        : { kind, rate: measurement.errorRequests / measurement.requests };
    case RuleKind.quality:
      // 品質は測れていないことがある (評価を 1 度も走らせていない・採点 0 件)
      return measurement.worstQualityScore === null
        ? null
        : { kind, score: measurement.worstQualityScore };
  }
}

// 実測値を 1 つの数値 (比較できる形) にする。コストだけは BigInt のまま返す —
// **Number() を挟むと 2^53 を超える額で「超えていない」ことになる**
// (JS の関係演算子は BigInt と Number を数学的に正しく比べるので、変換しなければ正確)
function observedValue(observation: RuleObservation): number | bigint {
  // 種別ごとに項目名が違うので取り出し方を分ける
  switch (observation.kind) {
    case RuleKind.cost:
      return observation.costMicroUsd;
    case RuleKind.error_rate:
      return observation.rate;
    case RuleKind.quality:
      return observation.score;
  }
}

/**
 * 1 つのルールが発火するかを判定する。
 *
 * **向きは `RULE_COMPARISON` の表から引く。** 種別ごとに `>` / `<` を書き下すと、
 * 表と実装が食い違っても誰も気付かない飾りの表になる (実測で、表の品質の向きを逆にしても
 * 全テストが緑のまま通った)。表を読むことで、表を書き換えれば挙動が変わる = 検出網が効く。
 */
export function evaluateRule(
  kind: RuleKind,
  threshold: number,
  measurement: GuardrailMeasurement,
): RuleEvaluation {
  // その種別が窓の中で測った値 (測れていなければ null)
  const observation = observe(kind, measurement);
  // 測れていなければ発火させない (fail-safe)
  if (observation === null) return NOT_FIRED;
  // 比較できる形にした実測値
  const value = observedValue(observation);
  // 種別ごとの向き (コスト・エラー率は上回ったら、品質は下回ったら発火)
  const exceeded =
    RULE_COMPARISON[kind] === RuleComparison.above ? value > threshold : value < threshold;
  // しきい値を越えていなければ発火しない (ちょうどの値は発火させない)
  if (!exceeded) return NOT_FIRED;
  // 越えたので、実測値を添えて発火を返す
  return { fired: true, observation };
}
