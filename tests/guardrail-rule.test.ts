// ガードレールのしきい値判定 (src/domain/guardrail/rule.ts) の検査。
// **種別ごとに「向き」と「測れないときの倒れ方」を固定する** — 1 種別だけ見ていると、
// 品質の規則をコストに流用した誤判定や、測れない窓で勝手に止める実装が緑のまま通る。
// ゲート (scripts/gate-step4.mjs) はテスト名 `発火: <種別>` を RuleKind から導いて照合するので、
// **その名前を変えない**（種別を足してテストを書き忘れたらゲートが落ちる）
import { describe, expect, it } from 'vitest';
import {
  evaluateRule,
  guardrailWindow,
  isValidWindowMinutes,
  RULE_COMPARISON,
  RuleComparison,
  thresholdRangeFor,
  worstQualityScore,
  type GuardrailMeasurement,
} from '@/domain/guardrail/rule';
import { RuleKind } from '@/domain/types';
import {
  GUARDRAIL_COST_THRESHOLD_MAX,
  GUARDRAIL_WINDOW_MAX_MINUTES,
  GUARDRAIL_WINDOW_MIN_MINUTES,
} from '@/lib/constants';

// 測定値の素材 (必要な項目だけ上書きできるようにする)
function measurement(overrides: Partial<GuardrailMeasurement> = {}): GuardrailMeasurement {
  // 既定は「何も起きていない窓」
  return {
    requests: 0,
    errorRequests: 0,
    costMicroUsd: 0n,
    worstQualityScore: null,
    ...overrides,
  };
}

describe('ガードレールの集計窓', () => {
  it('いまから過去 N 分の半開区間を作る', () => {
    // 基準時刻
    const now = new Date('2026-10-02T12:00:00.000Z');
    // 15 分の窓
    const window = guardrailWindow(
      now,
      15,
      GUARDRAIL_WINDOW_MIN_MINUTES,
      GUARDRAIL_WINDOW_MAX_MINUTES,
    );
    // 開始は 15 分前、終了は基準時刻そのもの
    expect(window?.start.toISOString()).toBe('2026-10-02T11:45:00.000Z');
    expect(window?.endExclusive.toISOString()).toBe('2026-10-02T12:00:00.000Z');
  });

  it('渡した Date を書き換えない (呼び出し側の時刻が動かない)', () => {
    // 基準時刻を作って控えておく
    const now = new Date('2026-10-02T12:00:00.000Z');
    const before = now.toISOString();
    // 窓を作る
    guardrailWindow(now, 60, GUARDRAIL_WINDOW_MIN_MINUTES, GUARDRAIL_WINDOW_MAX_MINUTES);
    // 元の Date は変わっていない
    expect(now.toISOString()).toBe(before);
  });

  it('範囲外の長さでは窓を作らない (fail-open を防ぐ)', () => {
    // 基準時刻
    const now = new Date('2026-10-02T12:00:00.000Z');
    // 窓を作ろうとする値と、それが駄目な理由
    const rejected = [
      0, // 幅ゼロ。1 件も拾わないので**どの種別も永久に発火しない**
      -5, // start が end より後になり同じ結果
      GUARDRAIL_WINDOW_MAX_MINUTES + 1, // 上限超え。判定は中継 1 回ごとに走るので全件走査になる
      1.5, // 整数でない (DB の Int 列に入らない)
      Number.NaN, // Invalid Date になり、入力検証ではなくクエリの境界で落ちる
    ];
    // どれも null を返す (呼び出し側が「判定できない」として扱う)
    for (const minutes of rejected) {
      expect(
        guardrailWindow(now, minutes, GUARDRAIL_WINDOW_MIN_MINUTES, GUARDRAIL_WINDOW_MAX_MINUTES),
      ).toBeNull();
    }
  });

  it('境界ちょうどの長さは受け付ける', () => {
    // 下限と上限はどちらも「含む」
    expect(
      isValidWindowMinutes(GUARDRAIL_WINDOW_MIN_MINUTES, 1, GUARDRAIL_WINDOW_MAX_MINUTES),
    ).toBe(true);
    expect(
      isValidWindowMinutes(GUARDRAIL_WINDOW_MAX_MINUTES, 1, GUARDRAIL_WINDOW_MAX_MINUTES),
    ).toBe(true);
  });
});

describe('しきい値の範囲', () => {
  it('コストはマイクロ USD の上限まで、割合の種別は 0〜1', () => {
    // コストは金額なので上限が大きい
    expect(thresholdRangeFor(RuleKind.cost, GUARDRAIL_COST_THRESHOLD_MAX)).toEqual({
      min: 0,
      max: GUARDRAIL_COST_THRESHOLD_MAX,
    });
    // エラー率と品質は比率なので 0〜1
    expect(thresholdRangeFor(RuleKind.error_rate, GUARDRAIL_COST_THRESHOLD_MAX)).toEqual({
      min: 0,
      max: 1,
    });
    expect(thresholdRangeFor(RuleKind.quality, GUARDRAIL_COST_THRESHOLD_MAX)).toEqual({
      min: 0,
      max: 1,
    });
  });

  it('比べ方の表が全種別を覆っている (向きを決めずに種別を足せない)', () => {
    // RuleKind の値すべてに向きが定義されている
    for (const kind of Object.values(RuleKind)) {
      expect(Object.values(RuleComparison)).toContain(RULE_COMPARISON[kind]);
    }
  });
});

describe('品質スコアの読み取り', () => {
  it('3 観点のうち最も低い値を採る (1 観点の崩れを他が埋めて隠さない)', () => {
    // 安全性だけが低い
    expect(worstQualityScore({ accuracy: 0.9, safety: 0.3, deviation: 0.95 })).toBe(0.3);
  });

  it('評価実行が無ければ null (測れていない)', () => {
    // 実行そのものが無い
    expect(worstQualityScore(null)).toBeNull();
  });

  it('1 観点でも欠けていれば null (残った観点だけで判定しない)', () => {
    // 採点 0 件のときは 3 つとも null になる約束だが、片方だけ欠けた行も「測れていない」扱い
    expect(worstQualityScore({ accuracy: 0.9, safety: null, deviation: 0.9 })).toBeNull();
    expect(worstQualityScore({ accuracy: null, safety: null, deviation: null })).toBeNull();
  });

  it('0 は欠けと区別される (0.0 を null に倒さない)', () => {
    // 実際に 0 点だったケース (測れている)
    expect(worstQualityScore({ accuracy: 0, safety: 0.5, deviation: 0.5 })).toBe(0);
  });
});

describe('発火: cost', () => {
  it('しきい値を超えたら発火し、実測の料金を返す', () => {
    // 1,500 マイクロ USD 使った窓で、しきい値 1,000
    expect(evaluateRule(RuleKind.cost, 1_000, measurement({ costMicroUsd: 1_500n }))).toEqual({
      fired: true,
      observation: { kind: RuleKind.cost, costMicroUsd: 1_500n },
    });
  });

  it('しきい値ちょうどでは発火しない (超過した場合だけ)', () => {
    // ちょうど 1,000
    expect(evaluateRule(RuleKind.cost, 1_000, measurement({ costMicroUsd: 1_000n }))).toEqual({
      fired: false,
    });
  });

  it('料金が 0 の窓では発火しない', () => {
    // 呼び出しが無い窓
    expect(evaluateRule(RuleKind.cost, 0.5, measurement({ costMicroUsd: 0n }))).toEqual({
      fired: false,
    });
  });

  it('倍精度で表せない大きさでも正しく比べる (BigInt を数値へ丸めていない)', () => {
    // 2^53 を超える料金と、1 だけ小さいしきい値。Number へ変換すると両方 9007199254740992 になり
    // 「超えていない」と誤判定する (JS の関係演算子は BigInt と Number を数学的に正しく比べる)
    const cost = 9_007_199_254_740_993n;
    // しきい値は 2^53 (倍精度で正確に表せる値)
    expect(
      evaluateRule(RuleKind.cost, 9_007_199_254_740_992, measurement({ costMicroUsd: cost })),
    ).toEqual({ fired: true, observation: { kind: RuleKind.cost, costMicroUsd: cost } });
  });
});

describe('発火: error_rate', () => {
  it('しきい値を超えたら発火し、実測の割合を返す', () => {
    // 10 件中 3 件が失敗 (30%) で、しきい値 20%
    expect(
      evaluateRule(RuleKind.error_rate, 0.2, measurement({ requests: 10, errorRequests: 3 })),
    ).toEqual({ fired: true, observation: { kind: RuleKind.error_rate, rate: 0.3 } });
  });

  it('しきい値ちょうどでは発火しない', () => {
    // 10 件中 2 件 (20%) で、しきい値 20%
    expect(
      evaluateRule(RuleKind.error_rate, 0.2, measurement({ requests: 10, errorRequests: 2 })),
    ).toEqual({ fired: false });
  });

  it('呼び出しが 0 件の窓では発火しない (0/0 は測れない)', () => {
    // 分母が 0。**ここで発火させると、使われていないエージェントが勝手に止まる**
    expect(
      evaluateRule(RuleKind.error_rate, 0, measurement({ requests: 0, errorRequests: 0 })),
    ).toEqual({ fired: false });
  });

  it('分母が 0 なのに失敗だけ数えられている測定値でも発火しない', () => {
    // **この形が「呼び出し 0 件」の門番が実際に効く唯一の入口。**
    // `0 / 0` は NaN で `NaN > しきい値` は常に false なので、門番が無くても偶然 false になる。
    // 一方この形は `3 / 0 = Infinity` で、門番が無いと**どんなしきい値でも必ず発火する** —
    // 集計の取り方を変えたときに分母と分子の整合が崩れると、使われていないエージェントが
    // 一斉に suspended になる (§9 fail-safe なので「測れない」側へ倒す)
    expect(
      evaluateRule(RuleKind.error_rate, 0.9, measurement({ requests: 0, errorRequests: 3 })),
    ).toEqual({ fired: false });
  });

  it('全件失敗した窓では発火する', () => {
    // 5 件中 5 件が失敗 (100%)
    expect(
      evaluateRule(RuleKind.error_rate, 0.5, measurement({ requests: 5, errorRequests: 5 })),
    ).toEqual({ fired: true, observation: { kind: RuleKind.error_rate, rate: 1 } });
  });
});

describe('発火: quality', () => {
  it('しきい値を下回ったら発火し、実測のスコアを返す (向きが逆)', () => {
    // 品質 0.4 で、しきい値 0.7
    expect(evaluateRule(RuleKind.quality, 0.7, measurement({ worstQualityScore: 0.4 }))).toEqual({
      fired: true,
      observation: { kind: RuleKind.quality, score: 0.4 },
    });
  });

  it('しきい値ちょうどでは発火しない', () => {
    // ちょうど 0.7
    expect(evaluateRule(RuleKind.quality, 0.7, measurement({ worstQualityScore: 0.7 }))).toEqual({
      fired: false,
    });
  });

  it('しきい値を上回っていれば発火しない (コストと同じ向きで判定していない)', () => {
    // 品質 0.9 はしきい値 0.7 より良い
    expect(evaluateRule(RuleKind.quality, 0.7, measurement({ worstQualityScore: 0.9 }))).toEqual({
      fired: false,
    });
  });

  it('測れていなければ発火しない (採点 0 件を最低品質と読まない)', () => {
    // 評価を 1 度も走らせていない・採点が 0 件だった
    expect(evaluateRule(RuleKind.quality, 0.7, measurement({ worstQualityScore: null }))).toEqual({
      fired: false,
    });
  });

  it('実際に 0 点なら発火する (0 を「測れていない」に倒していない)', () => {
    // 測れていて 0 点
    expect(evaluateRule(RuleKind.quality, 0.1, measurement({ worstQualityScore: 0 }))).toEqual({
      fired: true,
      observation: { kind: RuleKind.quality, score: 0 },
    });
  });
});
