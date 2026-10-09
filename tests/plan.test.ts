// プラン別の上限と可否（`src/domain/plan.ts`）の境界。
//
// ここで固定するのは 3 系統:
//   1. 表の網羅（プランを足して値を埋め忘れたら落ちる。型でも落ちるが、実行時の形も見る）
//   2. fail-closed（未知のプラン・未知の機能は最も厳しい側へ倒れる）
//   3. **`FALLBACK_PLAN` が本当に最も厳しいか** — 倒れ先が最も厳しくないと、未知の値が来たときに
//      上限が緩む側へ倒れる（fail-closed の向きが逆になる）。プランを足したときに気付く唯一の経路
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_PLAN,
  GUARDRAIL_RULE_ROWS_FACTOR,
  PLAN_FEATURES,
  PLAN_LIMITS,
  guardrailRuleLimitsFor,
  planAllows,
  planLimitsFor,
  type PlanFeature,
} from '@/domain/plan';
import { Plan } from '@/domain/types';
import { captureLogOutlet } from './lib/log-lines';

// enum の全プラン（正準は src/domain/types.ts）
const ALL_PLANS = Object.values(Plan);

describe('プランの表', () => {
  it('enum の全プランを網羅する', () => {
    // 表のキーと enum の値が一致する（プランを足して表を埋め忘れたら落ちる）
    expect(Object.keys(PLAN_LIMITS).sort()).toEqual([...ALL_PLANS].sort());
  });

  it.each(ALL_PLANS)('%s の上限はすべて正の整数', (plan) => {
    // 上限を引く
    const limits = PLAN_LIMITS[plan];
    // 3 つの数値の上限はどれも 1 以上の整数（0 や小数だと「誰も使えない」「比較が揺れる」）
    for (const value of [
      limits.maxAgents,
      limits.proxyRateLimitPerMinute,
      limits.maxEnabledGuardrailRules,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it.each(ALL_PLANS)('%s の機能は宣言済みの名前だけを含む', (plan) => {
    // 表に書いた機能が PLAN_FEATURES の外の綴りでないことを見る（綴り違いは静かに「使えない」になる）
    for (const feature of PLAN_LIMITS[plan].features) {
      expect(PLAN_FEATURES).toContain(feature);
    }
  });
});

describe('倒れ先のプラン', () => {
  it('どの上限でも最も小さく、機能も最小である', () => {
    // 倒れ先の上限
    const fallback = PLAN_LIMITS[FALLBACK_PLAN];
    // すべてのプランと比べて、3 つの上限が最小であることを確かめる
    for (const plan of ALL_PLANS) {
      const limits = PLAN_LIMITS[plan];
      expect(fallback.maxAgents).toBeLessThanOrEqual(limits.maxAgents);
      expect(fallback.proxyRateLimitPerMinute).toBeLessThanOrEqual(limits.proxyRateLimitPerMinute);
      expect(fallback.maxEnabledGuardrailRules).toBeLessThanOrEqual(
        limits.maxEnabledGuardrailRules,
      );
      // 機能は「どのプランの集合にも含まれる」= 全プランの共通部分の部分集合であること
      for (const feature of fallback.features) {
        expect(limits.features.has(feature)).toBe(true);
      }
    }
  });
});

describe('上限の引き方', () => {
  it.each(ALL_PLANS)('%s は表の値をそのまま返す', (plan) => {
    // 関数経由でも表と同じ値が返る（間に写しを作っていないこと）
    expect(planLimitsFor(plan)).toBe(PLAN_LIMITS[plan]);
  });

  it('未知のプランは最も厳しいプランの上限へ倒れ、ログに残る', () => {
    // ログを捕まえる（黙って倒れると運用者が気付けないので、1 行出ることまで見る）。
    // **出口のメソッドは深刻度で決まる**ので両方を捕まえる（正本は `LOG_EVENTS`）
    const outlet = captureLogOutlet();
    try {
      // DB の enum 外の値が来た状況を作る（型は Plan だが実行時は任意の文字列になりうる）
      const limits = planLimitsFor('platinum' as Plan);
      // 倒れ先の上限が返る
      expect(limits).toBe(PLAN_LIMITS[FALLBACK_PLAN]);
      // ログが 1 行出ている
      expect(outlet.calls()).toHaveLength(1);
    } finally {
      // **`finally` で戻す** — 検査が落ちた回に `console` のスパイが残ると、
      // 後続のテストの出力が消えて原因が読めなくなる
      outlet.restore();
    }
  });

  it('プロトタイプ由来の名前でも倒れる（素の添字にしていないこと）', () => {
    // `constructor` は Object.prototype 経由で引けてしまう名前。素の添字だと関数が返り、
    // 上限の比較が TypeError になる（`canPerform` が同じ理由で Object.hasOwn を使っている）
    const outlet = captureLogOutlet();
    try {
      expect(planLimitsFor('constructor' as Plan)).toBe(PLAN_LIMITS[FALLBACK_PLAN]);
    } finally {
      outlet.restore();
    }
  });
});

describe('機能の可否', () => {
  it.each(
    // 「全プラン × 全機能」の組を作る（表に書いた可否をそのまま確かめる）
    ALL_PLANS.flatMap((plan) => PLAN_FEATURES.map((feature) => [plan, feature] as const)),
  )('%s × %s は表のとおり', (plan, feature) => {
    // 判定が表と一致する（判定を書き下していないこと）
    expect(planAllows(plan, feature)).toBe(PLAN_LIMITS[plan].features.has(feature));
  });

  it('未知のプラン・未知の機能はどちらも拒否', () => {
    // 未知のプランは何も使えない
    expect(planAllows('platinum' as Plan, 'auditChainVerify')).toBe(false);
    // プロトタイプ由来の名前も拒否（上と同じ理由）
    expect(planAllows('constructor' as Plan, 'auditChainVerify')).toBe(false);
    // 未知の機能名も拒否（集合に無いので false）
    expect(planAllows(Plan.enterprise, 'unknownFeature' as PlanFeature)).toBe(false);
  });
});

describe('ガードレールのルール数の 2 つの上限', () => {
  it.each(ALL_PLANS)('%s は行数の天井を有効側から導く', (plan) => {
    // 2 つの上限を組み立てる
    const limits = guardrailRuleLimitsFor(plan);
    // 有効側は表の値
    expect(limits.maxEnabled).toBe(PLAN_LIMITS[plan].maxEnabledGuardrailRules);
    // 行数の天井は有効側の定数倍（表に 2 つ持たせると「有効側より小さい天井」が書けてしまう）
    expect(limits.maxRows).toBe(limits.maxEnabled * GUARDRAIL_RULE_ROWS_FACTOR);
    // 天井は必ず有効側より大きい（等しいと無効化した行の分だけ作れなくなる）
    expect(limits.maxRows).toBeGreaterThan(limits.maxEnabled);
  });
});
