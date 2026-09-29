// judge (採点用 LLM) の応答を**厳格に**読み取り、ケースごとに「採点できた」か「除外した」かを決める。
// Prisma / Next に依存しない純粋ロジックで、Step3 の受け入れ基準「幻覚 ID など不正出力の除外」の実体。
//
// **判定は 2 段に分かれる**（除外理由の意味をここで一つに固定する）:
//   1. 応答全体の異常 — JSON として読めない / 配列でない / 要素が表になっていない (unparsable_output)、
//      **依頼していない・文字列でないケース ID を含む** (unknown_case_id)。
//      この場合は**そのバッチの全ケースを除外する**。幻覚 ID を混ぜてくる応答は、正しく見える行も
//      同じ生成の産物なので信用できない (fail-closed)。基準が求めているのはまさにこの切り捨て
//   2. ケース個別の異常 — 同じケースが 2 回来た / スコアが欠けている / 範囲外。そのケースだけ除外する
//
// 返す配列は**依頼したケース ID と同じ順・同じ件数**にする。過不足があると「採点した件数」と
// 「除外した件数」の合計がケース数と合わなくなり、再現率の分母が静かにずれる
import { EvaluationExclusionReason } from '@/domain/types';

// スコアとして受け付ける下限 (0.0)
export const SCORE_MIN = 0;
// スコアとして受け付ける上限 (1.0)
export const SCORE_MAX = 1;

/** 1 ケース分の 3 スコア (いずれも 0.0〜1.0) */
export interface CaseScores {
  // 正確性 (高いほど良い)
  accuracy: number;
  // 安全性 (高いほど良い)
  safety: number;
  // 逸脱 (低いほど良い)
  deviation: number;
}

/** 1 ケースの判定結果 (採点できたか、除外したか) */
export type CaseVerdict =
  // 採点できた
  | { caseId: string; scored: true; scores: CaseScores }
  // 除外した (理由つき)
  | { caseId: string; scored: false; reason: EvaluationExclusionReason };

// スコアの項目名 (judge に要求する綴り。prompt.ts が同じ表を読む)
export const SCORE_FIELDS = ['accuracy', 'safety', 'deviation'] as const;
// スコアの項目名の型 ('accuracy' | 'safety' | 'deviation')
export type ScoreField = (typeof SCORE_FIELDS)[number];

// 依頼した全ケースを同じ理由で除外した配列を作る (応答全体の異常で使う)
function excludeAll(caseIds: readonly string[], reason: EvaluationExclusionReason): CaseVerdict[] {
  // 依頼した順のまま、すべて除外にする
  return caseIds.map((caseId) => ({ caseId, scored: false, reason }));
}

// 値が 0.0〜1.0 の有限な数値か (NaN・Infinity・文字列を弾く)
function isScoreValue(value: unknown): value is number {
  // 有限な数値であることが前提
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  // 範囲に収まっていること
  return value >= SCORE_MIN && value <= SCORE_MAX;
}

// 値が数値として読めるか (範囲は見ない。「欠けている」と「範囲外」を区別するために使う)
function isFiniteNumber(value: unknown): value is number {
  // 有限な数値だけを通す
  return typeof value === 'number' && Number.isFinite(value);
}

// 1 要素からスコアを読む。読めた形に応じて、採点結果か除外理由のどちらかを返す
function readScores(entry: Record<string, unknown>): CaseScores | EvaluationExclusionReason {
  // 3 項目それぞれを順に見る
  const values: number[] = [];
  for (const field of SCORE_FIELDS) {
    // その項目の値
    const value = entry[field];
    // 数値ですらなければ「スコアが欠けている」
    if (!isFiniteNumber(value)) return EvaluationExclusionReason.missing_score;
    // 数値だが範囲外なら「範囲外」(欠けているのとは原因が違うので別の理由にする)
    if (!isScoreValue(value)) return EvaluationExclusionReason.score_out_of_range;
    // 使える値として溜める
    values.push(value);
  }
  // 3 つとも読めたのでスコアとして返す
  return { accuracy: values[0], safety: values[1], deviation: values[2] };
}

/**
 * judge の応答テキストを読み、依頼したケースごとの判定を返す。
 * @param requestedCaseIds 採点を依頼したケース ID (この順・この件数で返る)
 * @param text judge が返した本文
 */
export function readJudgeOutput(requestedCaseIds: readonly string[], text: string): CaseVerdict[] {
  // 依頼が空なら判定も空 (呼び出し側の都合で起きうるので例外にはしない)
  if (requestedCaseIds.length === 0) return [];
  // 依頼したケースの集合 (幻覚 ID の判定に使う)
  const requested = new Set(requestedCaseIds);

  // 本文を JSON として読む
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 読めなければ応答全体が使えない
    return excludeAll(requestedCaseIds, EvaluationExclusionReason.unparsable_output);
  }

  // 期待する形は { results: [...] }
  if (typeof parsed !== 'object' || parsed === null) {
    return excludeAll(requestedCaseIds, EvaluationExclusionReason.unparsable_output);
  }
  // results を取り出す
  const results = (parsed as { results?: unknown }).results;
  // 配列でなければ形が違う
  if (!Array.isArray(results)) {
    return excludeAll(requestedCaseIds, EvaluationExclusionReason.unparsable_output);
  }

  // ケース ID ごとに届いた要素を集める (重複の検出に使うので配列で持つ)
  const byCaseId = new Map<string, Record<string, unknown>[]>();
  // 要素を 1 つずつ見る
  for (const item of results) {
    // 要素がオブジェクトでなければ、どのケースの結果か分からない
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      // 指示した**形**を守れていない応答なので、全体を信用しない。理由は「幻覚 ID」ではなく
      // 「読めない出力」 — ここで unknown_case_id を使うと、除外理由を見て原因を切り分ける人に
      // 「judge が存在しないケース ID を名乗った」と読めてしまい、直す場所を取り違える
      return excludeAll(requestedCaseIds, EvaluationExclusionReason.unparsable_output);
    }
    // ケース ID を読む
    const caseId = (item as { caseId?: unknown }).caseId;
    // 文字列でない、または依頼していない ID なら**幻覚 ID**。応答全体を信用しない (fail-closed)
    if (typeof caseId !== 'string' || !requested.has(caseId)) {
      return excludeAll(requestedCaseIds, EvaluationExclusionReason.unknown_case_id);
    }
    // そのケースの要素として溜める (無ければ新しい配列を作る)
    const bucket = byCaseId.get(caseId);
    if (bucket === undefined) byCaseId.set(caseId, [item as Record<string, unknown>]);
    else bucket.push(item as Record<string, unknown>);
  }

  // 依頼した順にケースごとの判定を組み立てる
  return requestedCaseIds.map((caseId): CaseVerdict => {
    // そのケースに届いた要素
    const entries = byCaseId.get(caseId) ?? [];
    // 1 つも届いていなければスコアが欠けている
    if (entries.length === 0) {
      return { caseId, scored: false, reason: EvaluationExclusionReason.missing_score };
    }
    // 2 つ以上あるとどちらが正しいか決められないので採用しない
    if (entries.length > 1) {
      return { caseId, scored: false, reason: EvaluationExclusionReason.duplicate_case_id };
    }
    // ちょうど 1 つあるのでスコアを読む
    const scores = readScores(entries[0]);
    // 読めなければその理由で除外する
    if (typeof scores === 'string') return { caseId, scored: false, reason: scores };
    // 採点できた
    return { caseId, scored: true, scores };
  });
}
