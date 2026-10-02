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
export const RATIO_MAX = 1;

// 逸脱スコアが最良のときの値 (0.0〜1.0 で低いほど良いので、1 から引くと「高いほど良い」へ直せる)。
// **裸の 1 を書かない** — RATIO_MAX と同じ値だが意味が違う (あちらは割合の上限、こちらは反転の基点)
const DEVIATION_BEST = 1;

// 種別ごとのしきい値の範囲。コストはマイクロ USD の整数なので上限は金額の上限に合わせる
export function thresholdRangeFor(kind: RuleKind, costMax: number): ThresholdRange {
  // コストだけは金額の上限まで、割合の 2 種は 0〜1
  return kind === RuleKind.cost ? { min: 0, max: costMax } : { min: 0, max: RATIO_MAX };
}

/**
 * エラー率ルールが「失敗」として数える上流 HTTP ステータスの下限 (これ以上が失敗)。
 *
 * **ここが唯一の定義**で、memory アダプタの集計と prisma アダプタの SQL が同じ値を読む。
 * 2 か所に数値を書くと、アダプタごとに違う率を出しながらどちらのテストも緑になる
 * (memory で API テストが通り、prisma の契約テストも別の値で通る = ADR-0006 の死角)。
 *
 * 400 以上をまとめて失敗に数えるのは、台帳に載る `statusCode` が**上流の実際の値**で、
 * 4xx（入力の誤り・レート制限）も 5xx（上流の障害）もどちらも「その呼び出しは使えなかった」
 * という同じ事実を表すため。エージェントの健全性を見る指標としては区別しない。
 */
export const USAGE_ERROR_STATUS_FLOOR = 400;

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
 *
 * **終了は `now` を含む。** 判定は「いま記録した呼び出しの直後」に走るので、`now` を
 * 含まない形にすると**その呼び出し自身が窓から落ちる** — タイムスタンプがミリ秒精度で、
 * 記録と判定は同じミリ秒に収まるため。実測で、終了を `now` ちょうどにしていた版は
 * 中継の直後にコストルールが 1 件も発火しなかった（その呼び出しの料金が次の呼び出しまで
 * 数えられない fail-open）。
 *
 * 日次集計（`src/domain/usage-window.ts`）が半開なのは、**隣り合う日の窓**で境界の 1 件が
 * 二重に入る／どちらにも入らないのを防ぐため。こちらは「末尾がいまの移動窓」で隣の窓が
 * 無いので、その理由は上端には当てはまらない。**開始側は半開のまま**（`start` を含み、
 * `start` の 1 ミリ秒前は含まない）。
 *
 * **`includeFrom` を渡すと、その時刻まで開始側を広げる。** 判定の引き金になった行の時刻を
 * 渡すためのもので、**DB の時計がアプリより遅れているときに引き金の行が窓から落ちるのを防ぐ**。
 * `createdAt` は DB の `now()` が入れる値なので、遅れが窓の長さを超えると（たとえば窓 1 分で
 * 90 秒の遅れ）その行は `start` より前になり、しきい値を越えさせた当の支出が集計に入らない
 * （発火しない fail-open）。終了側を遅いほうに合わせるだけでは**この向きは塞げない**
 * （`evaluationBasisTime` が塞ぐのは DB が進んでいる向きだけ）。
 */
export function guardrailWindow(
  now: Date,
  windowMinutes: number,
  min: number,
  max: number,
  includeFrom?: Date,
): GuardrailWindow | null {
  // 範囲外の長さでは窓を作らない (呼び出し側が「判定できない」として扱う)
  if (!isValidWindowMinutes(windowMinutes, min, max)) return null;
  // 終了は「呼び出し時刻の 1 ミリ秒後」。Port の集計は `createdAt < endExclusive` で絞るので、
  // こうすると `now` ちょうどに記録された行まで含まれる（上のコメントの理由）。
  // **ミリ秒を足すのは精度の都合**で、タイムスタンプが同じミリ秒に収まる限り不可避
  const endExclusive = new Date(now.getTime() + 1);
  // 開始はそこから窓の長さだけ戻した時刻 (含む)
  const nominalStart = endExclusive.getTime() - windowMinutes * MILLIS_PER_MINUTE;
  // 引き金の行がそれより前なら、その時刻まで広げる (理由は上のコメント)
  const start = new Date(
    includeFrom === undefined ? nominalStart : Math.min(nominalStart, includeFrom.getTime()),
  );
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
 * 評価実行から「品質」として読む 1 つの数値を決める。**3 観点のうち最も悪いもの**を採る。
 *
 * 平均ではなく最悪値にするのは、1 観点だけが崩れた形 (正確性は保ったまま安全性が落ちた等) を
 * 他の観点が埋めて見えなくしないため。しきい値の列は 1 つなので、どれか 1 つでも割ったら
 * 発火する側に倒す (§9 fail-safe)。
 *
 * **向きをそろえてから比べる。** `accuracy` / `safety` は高いほど良いが、**`deviation` (逸脱) は
 * 低いほど良い** (0.0〜1.0。`prisma/schema.prisma` と `src/domain/evaluation/prompt.ts` が
 * そう宣言している)。素の `Math.min` を 3 つに当てると、**逸脱の無い完璧な実行 (deviation = 0) が
 * 品質 0 と読まれ、正のしきい値を持つ品質ルールが健全なエージェントを必ず停止させる**
 * (実測: 満点の採点 `{accuracy: 1, safety: 1, deviation: 0}` でしきい値 0.5 のルールが発火した)。
 * `1 - deviation` に直してから最小を採る。
 *
 * **1 観点でも null なら全体を null にする。** `scoredCases = 0` のときは 3 つとも null に
 * なる約束 (DB の CHECK 制約で守っている) なので実際には 3 つ揃って欠けるが、片方だけ欠けた
 * 行が将来現れたときに「残った観点だけで判定する」のは「測れた」と言えない。
 */
export function worstQualityScore(scores: QualityScores | null): number | null {
  // 評価実行そのものが無ければ測れていない
  if (scores === null) return null;
  // 3 観点のうち 1 つでも欠けていれば測れていない扱いにする
  if (scores.accuracy === null || scores.safety === null || scores.deviation === null) return null;
  // **逸脱だけ向きが逆**なので「高いほど良い」側へ直す (0 の逸脱 = 品質 1.0)
  const deviationAsQuality = DEVIATION_BEST - scores.deviation;
  // 向きのそろった 3 つのうち最も低いものが「最も悪い観点」
  return Math.min(scores.accuracy, scores.safety, deviationAsQuality);
}

/**
 * エラー率ルールが発火するのに必要な、窓の中の最小の呼び出し回数。
 *
 * **これが無いと「窓の中で 1 回だけ呼んで、それが失敗した」エージェントが必ず止まる**
 * (1/1 = 100% なので、しきい値をどう置いても超える)。失敗には送り主自身のペイロードの誤り
 * (4xx) も入るので、低トラフィックのエージェントがたった 1 回のミスで suspended になり、
 * 復帰には人の操作 (UC-09) が要る。
 *
 * 「測れていないものは発火させない」(呼び出し 0 件の窓・採点 0 件の評価) と同じ考え方の延長で、
 * **分母が小さすぎる割合は「測れていない」側に倒す**。値は「1 件や 2 件の偶然では止めず、
 * それでも早めに気付ける」ところに置いた (20 件なら 1 件の失敗は 5% で、現実的なしきい値
 * (10〜50%) には届かない)。コストと品質には要らない (合計と平均スコアは 1 件でも意味を持つ)。
 *
 * **ここに置くのは `src/domain/` が `src/lib/` を参照しないため** (ドメインは純粋に保つ)。
 */
export const GUARDRAIL_ERROR_RATE_MIN_REQUESTS = 20;

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
      // どんなしきい値でも必ず発火する (集計の分母と分子の整合が崩れたときに全件停止する)。
      //
      // **分母が小さすぎる割合も「測れていない」側に倒す** (GUARDRAIL_ERROR_RATE_MIN_REQUESTS)。
      // 1 件だけ呼んで失敗した窓は 1/1 = 100% なので、しきい値をどう置いても必ず超える —
      // 失敗には送り主自身のペイロードの誤り (4xx) も入るので、低トラフィックのエージェントが
      // たった 1 回のミスで自動停止し、復帰に人の操作が要る状態になる
      return measurement.requests < GUARDRAIL_ERROR_RATE_MIN_REQUESTS
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
