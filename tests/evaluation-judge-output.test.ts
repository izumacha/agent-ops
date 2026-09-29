// judge の応答の読み取り (src/domain/evaluation/judge-output.ts) を固定する。
// **除外理由ごとのテスト名は `除外: <理由>` で始める** — ゲート (scripts/gate-step3.mjs) は
// enum EvaluationExclusionReason からこの名前を導いて「全種類ぶん pass しているか」を見るので、
// 理由を足してテストを書き忘れると落ちる (料金表からモデル名を導くのと同じ形)
import { describe, expect, it } from 'vitest';
import { readJudgeOutput, SCORE_MAX, SCORE_MIN } from '@/domain/evaluation/judge-output';
import { EvaluationExclusionReason } from '@/domain/types';

// テストで使うケース ID (依頼する順序も兼ねる)
const CASE_IDS = ['case_1', 'case_2', 'case_3'];

// 正常な 1 件分の採点結果を作る
function scored(caseId: string, accuracy: number, safety: number, deviation: number) {
  // judge が返す 1 要素の形
  return { caseId, accuracy, safety, deviation };
}

// results を JSON 文字列にする
function body(results: unknown[]): string {
  // judge の応答本文と同じ形
  return JSON.stringify({ results });
}

describe('judge の応答を読み取る', () => {
  it('3 件すべて採点できる', () => {
    // 依頼した 3 件ぶんの結果を返す応答
    const verdicts = readJudgeOutput(
      CASE_IDS,
      body([scored('case_1', 1, 1, 0), scored('case_2', 0.5, 0.9, 0.1), scored('case_3', 0, 0, 1)]),
    );
    // 依頼した順・件数で返ること
    expect(verdicts.map((v) => v.caseId)).toEqual(CASE_IDS);
    // すべて採点できていること
    expect(verdicts.every((v) => v.scored)).toBe(true);
    // 2 件目のスコアがそのまま読めていること
    expect(verdicts[1]).toEqual({
      caseId: 'case_2',
      scored: true,
      scores: { accuracy: 0.5, safety: 0.9, deviation: 0.1 },
    });
  });

  it('知らない項目が混ざっていても採点は読める', () => {
    // judge が余分な項目 (reason) を足してきた応答
    const verdicts = readJudgeOutput(
      ['case_1'],
      body([{ ...scored('case_1', 0.8, 0.8, 0.2), reason: '理由の説明' }]),
    );
    // 余分な項目は無視して採点できること (厳しくしすぎると正常な judge まで落とすため)
    expect(verdicts[0]).toEqual({
      caseId: 'case_1',
      scored: true,
      scores: { accuracy: 0.8, safety: 0.8, deviation: 0.2 },
    });
  });

  it('境界値 (0.0 と 1.0) は採点として受け付ける', () => {
    // 下限と上限ちょうどの値
    const verdicts = readJudgeOutput(
      ['case_1'],
      body([scored('case_1', SCORE_MIN, SCORE_MAX, SCORE_MIN)]),
    );
    // 受け付けること
    expect(verdicts[0].scored).toBe(true);
  });

  it('依頼が空なら判定も空', () => {
    // 呼び出し側の都合で起きうるので例外にはしない
    expect(readJudgeOutput([], body([]))).toEqual([]);
  });

  it('除外: unparsable_output — JSON として読めない応答は全件を捨てる', () => {
    // judge が散文を返した
    const verdicts = readJudgeOutput(CASE_IDS, 'すみません、採点できませんでした。');
    // 全件が同じ理由で除外されること
    expect(verdicts).toHaveLength(CASE_IDS.length);
    expect(
      verdicts.every((v) => !v.scored && v.reason === EvaluationExclusionReason.unparsable_output),
    ).toBe(true);
  });

  it('除外: unparsable_output — results が配列でない応答も全件を捨てる', () => {
    // 形だけ JSON だが results が配列でない
    const verdicts = readJudgeOutput(CASE_IDS, JSON.stringify({ results: { case_1: 1 } }));
    // 全件が除外されること
    expect(
      verdicts.every((v) => !v.scored && v.reason === EvaluationExclusionReason.unparsable_output),
    ).toBe(true);
  });

  it('除外: unparsable_output — results の要素が表になっていない応答も全件を捨てる', () => {
    // results は配列だが、中身が文字列・数値・配列で「どのケースの結果か」を読めない
    const verdicts = readJudgeOutput(CASE_IDS, JSON.stringify({ results: ['case_1', 1, []] }));
    // 全件が除外されること。理由は**幻覚 ID ではなく読めない出力** —
    // judge は存在しない ID を名乗ったのではなく、指示した形を守れていない
    expect(verdicts).toHaveLength(CASE_IDS.length);
    expect(
      verdicts.every((v) => !v.scored && v.reason === EvaluationExclusionReason.unparsable_output),
    ).toBe(true);
  });

  it('除外: unknown_case_id — セットに無いケース ID が 1 つでもあれば全件を捨てる', () => {
    // 1 件目は正しいが 2 件目が幻覚 ID
    const verdicts = readJudgeOutput(
      CASE_IDS,
      body([scored('case_1', 1, 1, 0), scored('case_999', 1, 1, 0)]),
    );
    // **正しく見える case_1 も含めて**全件が除外されること (同じ生成の産物なので信用しない)
    expect(verdicts).toHaveLength(CASE_IDS.length);
    expect(
      verdicts.every((v) => !v.scored && v.reason === EvaluationExclusionReason.unknown_case_id),
    ).toBe(true);
  });

  it('除外: unknown_case_id — caseId が文字列でない要素も同じ扱いにする', () => {
    // caseId が数値で返ってきた (指示した形を守れていない証拠)
    const verdicts = readJudgeOutput(
      CASE_IDS,
      body([{ caseId: 1, accuracy: 1, safety: 1, deviation: 0 }]),
    );
    // 全件が除外されること
    expect(
      verdicts.every((v) => !v.scored && v.reason === EvaluationExclusionReason.unknown_case_id),
    ).toBe(true);
  });

  it('除外: duplicate_case_id — 同じケースが 2 回来たらそのケースだけ捨てる', () => {
    // case_1 が 2 回、case_2 は 1 回
    const verdicts = readJudgeOutput(
      ['case_1', 'case_2'],
      body([scored('case_1', 1, 1, 0), scored('case_1', 0, 0, 1), scored('case_2', 0.5, 0.5, 0.5)]),
    );
    // case_1 は重複で除外
    expect(verdicts[0]).toEqual({
      caseId: 'case_1',
      scored: false,
      reason: EvaluationExclusionReason.duplicate_case_id,
    });
    // case_2 は採点できる (個別の異常は他のケースを巻き込まない)
    expect(verdicts[1].scored).toBe(true);
  });

  it('除外: missing_score — 項目が欠けているケースだけ捨てる', () => {
    // case_1 は deviation が無い
    const verdicts = readJudgeOutput(
      ['case_1', 'case_2'],
      body([{ caseId: 'case_1', accuracy: 1, safety: 1 }, scored('case_2', 0.5, 0.5, 0.5)]),
    );
    // case_1 は欠けているので除外
    expect(verdicts[0]).toEqual({
      caseId: 'case_1',
      scored: false,
      reason: EvaluationExclusionReason.missing_score,
    });
    // case_2 は採点できる
    expect(verdicts[1].scored).toBe(true);
  });

  it('除外: missing_score — 結果が返らなかったケースも同じ理由で捨てる', () => {
    // case_2 の結果が応答に無い
    const verdicts = readJudgeOutput(['case_1', 'case_2'], body([scored('case_1', 1, 1, 0)]));
    // 返らなかった case_2 は欠けている扱い
    expect(verdicts[1]).toEqual({
      caseId: 'case_2',
      scored: false,
      reason: EvaluationExclusionReason.missing_score,
    });
  });

  it('除外: missing_score — 数値でない値 (文字列・NaN) も欠けている扱いにする', () => {
    // 文字列と NaN (NaN は JSON に書けないので null として届く)
    const verdicts = readJudgeOutput(
      ['case_1', 'case_2'],
      body([
        { caseId: 'case_1', accuracy: '1.0', safety: 1, deviation: 0 },
        { caseId: 'case_2', accuracy: null, safety: 1, deviation: 0 },
      ]),
    );
    // どちらも欠けている扱い
    expect(verdicts.map((v) => (v.scored ? 'scored' : v.reason))).toEqual([
      EvaluationExclusionReason.missing_score,
      EvaluationExclusionReason.missing_score,
    ]);
  });

  it('除外: score_out_of_range — 範囲外のスコアはそのケースだけ捨てる', () => {
    // 下限未満と上限超過
    const verdicts = readJudgeOutput(
      ['case_1', 'case_2'],
      body([scored('case_1', -0.1, 1, 0), scored('case_2', 1, 1.1, 0)]),
    );
    // どちらも範囲外で除外 (「欠けている」とは原因が違うので別の理由)
    expect(verdicts.map((v) => (v.scored ? 'scored' : v.reason))).toEqual([
      EvaluationExclusionReason.score_out_of_range,
      EvaluationExclusionReason.score_out_of_range,
    ]);
  });

  it('返す件数と順序は依頼したケースと必ず一致する', () => {
    // judge が順序を入れ替えて返した
    const verdicts = readJudgeOutput(
      CASE_IDS,
      body([scored('case_3', 1, 1, 0), scored('case_1', 1, 1, 0)]),
    );
    // 依頼した順のまま返ること (件数も一致)
    expect(verdicts.map((v) => v.caseId)).toEqual(CASE_IDS);
  });
});
