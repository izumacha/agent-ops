// 採点結果の集計と、2 回の採点の**一致率**。Step3 の受け入れ基準「固定評価セット 100 件で
// 採点の再現率 ≧ 90%」の「再現率」の定義はこのファイルが唯一の場所で、ベンチ
// (scripts/bench-evaluation.ts) もゲートもここを読む。
import type { CaseVerdict } from './judge-output';

/** 1 実行ぶんの集計 (EvaluationRun に保存する形) */
export interface RunTotals {
  // 採点できたケースの平均 (1 件も採点できなければ null)
  accuracy: number | null;
  safety: number | null;
  deviation: number | null;
  // 採点できた件数 (上の平均の分母)
  scoredCases: number;
  // 除外した件数
  excludedCases: number;
}

// 数値の平均を求める (空配列なら null)。**0 を返さない**のが要点 —
// 「測れなかった」を 0.0 として保存すると、Step4 の品質低下ルールが最低品質と読んで誤発火する
function averageOrNull(values: readonly number[]): number | null {
  // 1 件も無ければ平均は存在しない
  if (values.length === 0) return null;
  // 合計を件数で割る
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** ケースごとの判定を 1 実行ぶんの集計へまとめる */
export function summarize(verdicts: readonly CaseVerdict[]): RunTotals {
  // 採点できたケースだけを取り出す
  const scored = verdicts.filter((verdict) => verdict.scored);
  // 3 項目それぞれの平均を求める
  return {
    accuracy: averageOrNull(scored.map((verdict) => verdict.scores.accuracy)),
    safety: averageOrNull(scored.map((verdict) => verdict.scores.safety)),
    deviation: averageOrNull(scored.map((verdict) => verdict.scores.deviation)),
    scoredCases: scored.length,
    excludedCases: verdicts.length - scored.length,
  };
}

/** 除外したケースの割合 (0.0〜1.0)。ケースが 0 件なら 0 とみなす */
export function exclusionRate(totals: RunTotals): number {
  // 分母は採点できた件数と除外した件数の合計
  const total = totals.scoredCases + totals.excludedCases;
  // ケースが 1 件も無ければ「除外していない」扱いにする (0 除算を避ける)
  if (total === 0) return 0;
  // 除外の割合
  return totals.excludedCases / total;
}

// 2 つの判定が「同じ採点結果」と言えるか。
// **スコアの比較は厳密等価**にする。丸めてから比べると、許容幅の分だけ揺れを見逃して
// 一致率が実際より高く出る (再現率は「同じ結果になったか」を数える指標なので、甘くしない)
function sameVerdict(left: CaseVerdict, right: CaseVerdict): boolean {
  // 片方だけが採点できているなら一致しない
  if (left.scored !== right.scored) return false;
  // どちらも除外なら、理由まで同じであることを求める (別の理由で落ちたなら再現していない)
  if (!left.scored || !right.scored) {
    return !left.scored && !right.scored && left.reason === right.reason;
  }
  // どちらも採点できているなら 3 スコアがすべて等しいこと
  return (
    left.scores.accuracy === right.scores.accuracy &&
    left.scores.safety === right.scores.safety &&
    left.scores.deviation === right.scores.deviation
  );
}

/**
 * 同じ評価セットを 2 回採点した結果の**一致率** (0.0〜1.0)。
 * **ケース ID で突き合わせる** — 配列の並びで比べると、片方だけ順序が変わったときに
 * 「全件不一致」という嘘の値が出る。
 * 片方にしか無いケースは不一致として数える (両方に無いケースは分母に入らない)。
 * @returns 突き合わせるケースが 1 件も無ければ null (「一致率を測れなかった」を 0% と区別する)
 */
export function agreementRate(
  first: readonly CaseVerdict[],
  second: readonly CaseVerdict[],
): number | null {
  // 2 回目の判定をケース ID で引けるようにする
  const secondById = new Map(second.map((verdict) => [verdict.caseId, verdict]));
  // 分母に入れるケース ID (どちらかに現れたものすべて)
  const caseIds = new Set([...first.map((v) => v.caseId), ...secondById.keys()]);
  // 1 件も無ければ測れない
  if (caseIds.size === 0) return null;
  // 1 回目をケース ID で引けるようにする
  const firstById = new Map(first.map((verdict) => [verdict.caseId, verdict]));
  // 一致した件数を数える
  let agreed = 0;
  for (const caseId of caseIds) {
    // 両方に存在し、同じ結果であれば一致
    const left = firstById.get(caseId);
    const right = secondById.get(caseId);
    if (left !== undefined && right !== undefined && sameVerdict(left, right)) agreed += 1;
  }
  // 一致率
  return agreed / caseIds.size;
}
