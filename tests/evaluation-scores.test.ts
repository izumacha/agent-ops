// 採点の集計と一致率 (src/domain/evaluation/scores.ts) を固定する。
// **一致率は受け入れ基準「再現率 ≧ 90%」の定義そのもの**なので、甘い方向へ緩む変更を落とす
import { describe, expect, it } from 'vitest';
import type { CaseVerdict } from '@/domain/evaluation/judge-output';
import { agreementRate, exclusionRate, summarize } from '@/domain/evaluation/scores';
import { EvaluationExclusionReason } from '@/domain/types';

// 採点できた判定を作る
function scored(caseId: string, accuracy: number, safety: number, deviation: number): CaseVerdict {
  // 3 スコアを持つ判定
  return { caseId, scored: true, scores: { accuracy, safety, deviation } };
}

// 除外した判定を作る
function excluded(caseId: string, reason: EvaluationExclusionReason): CaseVerdict {
  // 理由つきの判定
  return { caseId, scored: false, reason };
}

describe('1 実行ぶんの集計', () => {
  it('採点できたケースだけで平均を出す', () => {
    // 2 件採点・1 件除外
    const totals = summarize([
      scored('case_1', 1, 1, 0),
      scored('case_2', 0, 0.5, 0.4),
      excluded('case_3', EvaluationExclusionReason.missing_score),
    ]);
    // 平均は採点できた 2 件だけで割る (除外を 0 点として混ぜない)
    expect(totals.accuracy).toBe(0.5);
    expect(totals.safety).toBe(0.75);
    expect(totals.deviation).toBeCloseTo(0.2, 10);
    // 件数の内訳
    expect(totals.scoredCases).toBe(2);
    expect(totals.excludedCases).toBe(1);
  });

  it('1 件も採点できなければ平均は null (0.0 にしない)', () => {
    // 全件除外
    const totals = summarize([
      excluded('case_1', EvaluationExclusionReason.judge_unavailable),
      excluded('case_2', EvaluationExclusionReason.unparsable_output),
    ]);
    // **0.0 ではなく null**。0.0 だと Step4 の品質低下ルールが「最低品質」と読んで誤発火する
    expect(totals.accuracy).toBeNull();
    expect(totals.safety).toBeNull();
    expect(totals.deviation).toBeNull();
    expect(totals.scoredCases).toBe(0);
    expect(totals.excludedCases).toBe(2);
  });

  it('除外率は「除外 ÷ 全体」で、ケースが 0 件なら 0', () => {
    // 4 件中 1 件を除外
    expect(
      exclusionRate(
        summarize([
          scored('case_1', 1, 1, 0),
          scored('case_2', 1, 1, 0),
          scored('case_3', 1, 1, 0),
          excluded('case_4', EvaluationExclusionReason.agent_unavailable),
        ]),
      ),
    ).toBe(0.25);
    // 0 件のときは 0 除算を避けて 0 を返す
    expect(exclusionRate(summarize([]))).toBe(0);
  });
});

describe('2 回の採点の一致率', () => {
  it('まったく同じ結果なら 1.0', () => {
    // 同じ判定を 2 回
    const run = [scored('case_1', 1, 1, 0), scored('case_2', 0.5, 0.5, 0.5)];
    expect(agreementRate(run, run)).toBe(1);
  });

  it('スコアが 1 つでも違えばそのケースは不一致', () => {
    // 2 件中 1 件だけ deviation が違う
    const first = [scored('case_1', 1, 1, 0), scored('case_2', 0.5, 0.5, 0.5)];
    const second = [scored('case_1', 1, 1, 0), scored('case_2', 0.5, 0.5, 0.6)];
    expect(agreementRate(first, second)).toBe(0.5);
  });

  it('わずかな差でも不一致として数える (丸めて甘くしない)', () => {
    // 0.001 の違い。丸めて比べる実装なら一致してしまう
    const first = [scored('case_1', 0.5, 0.5, 0.5)];
    const second = [scored('case_1', 0.501, 0.5, 0.5)];
    expect(agreementRate(first, second)).toBe(0);
  });

  it('両方が同じ理由で除外されたケースは一致とみなす', () => {
    // 2 回とも judge が落ちた
    const reason = EvaluationExclusionReason.judge_unavailable;
    expect(agreementRate([excluded('case_1', reason)], [excluded('case_1', reason)])).toBe(1);
  });

  it('除外の理由が違えば不一致', () => {
    // 1 回目は欠け、2 回目は範囲外
    expect(
      agreementRate(
        [excluded('case_1', EvaluationExclusionReason.missing_score)],
        [excluded('case_1', EvaluationExclusionReason.score_out_of_range)],
      ),
    ).toBe(0);
  });

  it('片方だけ採点できたケースは不一致', () => {
    // 1 回目は採点でき、2 回目は除外された
    expect(
      agreementRate(
        [scored('case_1', 1, 1, 0)],
        [excluded('case_1', EvaluationExclusionReason.judge_unavailable)],
      ),
    ).toBe(0);
  });

  it('並び順が違っても ケース ID で突き合わせる', () => {
    // 同じ内容で順序だけ逆
    const first = [scored('case_1', 1, 1, 0), scored('case_2', 0, 0, 1)];
    const second = [scored('case_2', 0, 0, 1), scored('case_1', 1, 1, 0)];
    // 並びで比べる実装なら 0 になる
    expect(agreementRate(first, second)).toBe(1);
  });

  it('片方にしか無いケースは不一致として分母に入れる', () => {
    // 2 回目に case_2 が無い
    const first = [scored('case_1', 1, 1, 0), scored('case_2', 1, 1, 0)];
    const second = [scored('case_1', 1, 1, 0)];
    // 分母は 2 件、一致は 1 件
    expect(agreementRate(first, second)).toBe(0.5);
  });

  it('突き合わせるケースが 1 件も無ければ null (0% と区別する)', () => {
    // どちらも空
    expect(agreementRate([], [])).toBeNull();
  });
});
