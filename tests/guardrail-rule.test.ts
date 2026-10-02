// ガードレールのしきい値判定 (src/domain/guardrail/rule.ts) の検査。
// **種別ごとに「向き」と「測れないときの倒れ方」を固定する** — 1 種別だけ見ていると、
// 品質の規則をコストに流用した誤判定や、測れない窓で勝手に止める実装が緑のまま通る。
// ゲート (scripts/gate-step4.mjs) はテスト名 `発火: <種別>` を RuleKind から導いて照合するので、
// **その名前を変えない**（種別を足してテストを書き忘れたらゲートが落ちる）
import { describe, expect, it } from 'vitest';
import {
  evaluateRule,
  GUARDRAIL_ERROR_RATE_MIN_REQUESTS,
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
    // **窓は `(now - 15 分, now]` を覆う**（基準時刻を含み、長さはちょうど 15 分）。
    // Port の集計は `start <= createdAt < endExclusive` で絞るので、その形にするには
    // 両端を 1 ミリ秒ずつ後ろへ置くことになる。開始を `now - 15 分` のままにすると
    // 窓の長さが 15 分 + 1 ミリ秒になり、「直近 15 分の料金」という意味からずれる
    expect(window?.start.toISOString()).toBe('2026-10-02T11:45:00.001Z');
    expect(window?.endExclusive.toISOString()).toBe('2026-10-02T12:00:00.001Z');
    // 長さはちょうど 15 分
    expect(window!.endExclusive.getTime() - window!.start.getTime()).toBe(15 * 60 * 1000);
  });

  it('基準時刻ちょうどに記録された行を窓に含む（その呼び出し自身が落ちない）', () => {
    // **これが落ちていると、中継の直後の判定がその呼び出しの料金を数えない**（fail-open）。
    // 記録と判定は同じミリ秒に収まるので、終了を基準時刻ちょうど（含まない）にすると
    // 自分自身が窓の外になる。実測で、その版は中継の直後にコストルールが 1 件も発火しなかった
    const now = new Date('2026-10-02T12:00:00.000Z');
    const window = guardrailWindow(
      now,
      15,
      GUARDRAIL_WINDOW_MIN_MINUTES,
      GUARDRAIL_WINDOW_MAX_MINUTES,
    );
    // Port の集計は `createdAt < endExclusive` で絞るので、基準時刻ちょうどが窓の中に入る
    expect(now.getTime() < (window?.endExclusive.getTime() ?? 0)).toBe(true);
    // 窓の長さはちょうど 15 分のまま（上端を 1 ミリ秒ずらした分、下端も同じだけずれる）
    expect((window?.endExclusive.getTime() ?? 0) - (window?.start.getTime() ?? 0)).toBe(
      15 * 60 * 1000,
    );
    // 15 分より前（ちょうど境界）は窓の外
    expect((window?.start.getTime() ?? 0) > now.getTime() - 15 * 60 * 1000).toBe(true);
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

describe('集計窓: 引き金の行を取り込む', () => {
  it('引き金の行が窓の開始より前なら、その時刻まで広げる', () => {
    // **DB の時計がアプリより遅れている状況** — 窓 1 分に対して 90 秒前の行が引き金。
    // 広げないと、しきい値を越えさせた当の支出が集計に入らない（発火しない fail-open。
    // `evaluationBasisTime` が塞ぐのは DB が「進んでいる」向きだけ）
    const now = new Date('2026-10-02T12:00:00.000Z');
    const recordedAt = new Date(now.getTime() - 90_000);
    const window = guardrailWindow(
      now,
      1,
      GUARDRAIL_WINDOW_MIN_MINUTES,
      GUARDRAIL_WINDOW_MAX_MINUTES,
      recordedAt,
    );
    // 開始は引き金の行の時刻（含む）まで下がる
    expect(window?.start.getTime()).toBe(recordedAt.getTime());
    // 終端は変わらない
    expect(window?.endExclusive.toISOString()).toBe('2026-10-02T12:00:00.001Z');
  });

  it('引き金の行が窓の中なら窓は変わらない (無駄に広げない)', () => {
    // 窓 15 分に対して 1 分前の行（もともと窓の中）
    const now = new Date('2026-10-02T12:00:00.000Z');
    const inside = new Date(now.getTime() - 60_000);
    const widened = guardrailWindow(
      now,
      15,
      GUARDRAIL_WINDOW_MIN_MINUTES,
      GUARDRAIL_WINDOW_MAX_MINUTES,
      inside,
    );
    const plain = guardrailWindow(
      now,
      15,
      GUARDRAIL_WINDOW_MIN_MINUTES,
      GUARDRAIL_WINDOW_MAX_MINUTES,
    );
    expect(widened?.start.toISOString()).toBe(plain?.start.toISOString());
  });

  it('範囲外の長さなら引き金を渡しても窓は作らない (判定しない側に倒す)', () => {
    // 広げる処理が範囲の判定より先に走ると、不正な長さの窓が作れてしまう
    const now = new Date('2026-10-02T12:00:00.000Z');
    expect(
      guardrailWindow(
        now,
        GUARDRAIL_WINDOW_MAX_MINUTES + 1,
        GUARDRAIL_WINDOW_MIN_MINUTES,
        GUARDRAIL_WINDOW_MAX_MINUTES,
        new Date(now.getTime() - 1_000),
      ),
    ).toBeNull();
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
  it('3 観点のうち最も悪い値を採る (1 観点の崩れを他が埋めて隠さない)', () => {
    // 安全性だけが低い (逸脱は 0.05 = ほぼ無いので品質としては 0.95)
    expect(worstQualityScore({ accuracy: 0.9, safety: 0.3, deviation: 0.05 })).toBe(0.3);
  });

  it('逸脱は「低いほど良い」ので向きを直してから比べる', () => {
    // **これを間違えると、完璧な実行が「品質 0」と読まれて健全なエージェントが必ず停止する**。
    // 満点の採点 (逸脱なし) は品質 1.0
    expect(worstQualityScore({ accuracy: 1, safety: 1, deviation: 0 })).toBe(1);
    // 逸脱だけが最悪 (1.0) なら品質は 0
    expect(worstQualityScore({ accuracy: 1, safety: 1, deviation: 1 })).toBe(0);
    // 逸脱が一番悪い観点になる場合 (1 - 0.8 = 0.2 が最小)
    expect(worstQualityScore({ accuracy: 0.9, safety: 0.9, deviation: 0.8 })).toBeCloseTo(0.2);
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
  // 最小の呼び出し回数を満たす分母（これを下回る窓は「測れていない」側に倒す）
  const ENOUGH = GUARDRAIL_ERROR_RATE_MIN_REQUESTS;

  it('しきい値を超えたら発火し、実測の割合を返す', () => {
    // 全体の 30% が失敗で、しきい値 20%
    const errorRequests = ENOUGH * 0.3;
    expect(
      evaluateRule(RuleKind.error_rate, 0.2, measurement({ requests: ENOUGH, errorRequests })),
    ).toEqual({ fired: true, observation: { kind: RuleKind.error_rate, rate: 0.3 } });
  });

  it('しきい値ちょうどでは発火しない', () => {
    // ちょうど 20% で、しきい値 20%
    expect(
      evaluateRule(
        RuleKind.error_rate,
        0.2,
        measurement({ requests: ENOUGH, errorRequests: ENOUGH * 0.2 }),
      ),
    ).toEqual({ fired: false });
  });

  it('呼び出しが少なすぎる窓では発火しない (1 回の失敗で止めない)', () => {
    // **1 件だけ呼んで失敗した窓は 1/1 = 100%** なので、門番が無いとしきい値をどう置いても
    // 必ず発火する。失敗には送り主自身のペイロードの誤り (4xx) も入るので、低トラフィックの
    // エージェントがたった 1 回のミスで自動停止し、復帰に人の操作が要る状態になる
    expect(
      evaluateRule(RuleKind.error_rate, 0.5, measurement({ requests: 1, errorRequests: 1 })),
    ).toEqual({ fired: false });
    // 境界: 最小 - 1 件は測れていない / 最小ちょうどは測れている
    expect(
      evaluateRule(
        RuleKind.error_rate,
        0.5,
        measurement({ requests: ENOUGH - 1, errorRequests: ENOUGH - 1 }),
      ),
    ).toEqual({ fired: false });
    expect(
      evaluateRule(
        RuleKind.error_rate,
        0.5,
        measurement({ requests: ENOUGH, errorRequests: ENOUGH }),
      ),
    ).toEqual({ fired: true, observation: { kind: RuleKind.error_rate, rate: 1 } });
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
    // 分母が十分あって全件失敗 (100%)
    expect(
      evaluateRule(
        RuleKind.error_rate,
        0.5,
        measurement({ requests: ENOUGH, errorRequests: ENOUGH }),
      ),
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
