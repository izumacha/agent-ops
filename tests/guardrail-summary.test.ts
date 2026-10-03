// 発火の要約文（`Incident.summary` と通知本文に使う 1 行）の検査。
//
// この文は**インシデントの行として保存され、通知として外部の受け手へも送られる**ので、
// 「何がどのしきい値をどれだけ超えたのか」が後から読めることが要件。
// ここで固定するのは 2 つ: (a) **どの種別でも集計窓が文に出る**、
// (b) 実測値としきい値がそのまま読める形で入っている。
import { describe, expect, it } from 'vitest';
import { guardrailIncidentSummary } from '@/lib/guardrail/summary';
import type { RuleObservation } from '@/domain/guardrail/rule';
import { RuleKind } from '@/domain/types';
import { RULE_KIND_LABELS } from '@/lib/constants';

// 種別ごとの実測値（`RuleObservation` の全枝。枝が増えれば typecheck が落ちる）
const OBSERVATIONS: Readonly<Record<RuleKind, RuleObservation>> = {
  [RuleKind.cost]: { kind: RuleKind.cost, costMicroUsd: 1_500n },
  [RuleKind.error_rate]: { kind: RuleKind.error_rate, rate: 0.453 },
  [RuleKind.quality]: { kind: RuleKind.quality, score: 0.42 },
};
// 文に出てくるはずの窓の長さ（分）
const WINDOW_MINUTES = 90;

describe('発火の要約文', () => {
  // **窓を伏せると「1 分の窓を見たのか 7 日の窓を見たのか」が記録から読めない。**
  // 品質ルールだけ窓を出していなかったので、窓を見るようにした変更と対で固定する
  it.each(Object.values(RuleKind))('どの種別でも集計窓を文に出す (%s)', (kind) => {
    // その種別の文を組み立てる
    const summary = guardrailIncidentSummary(OBSERVATIONS[kind], 0.5, WINDOW_MINUTES);
    // 窓の長さが入っている
    expect(summary).toContain(String(WINDOW_MINUTES));
    // 種別のラベルも入っている（どのルールが発火したか分かる）
    expect(summary).toContain(RULE_KIND_LABELS[kind]);
  });

  it('コストはマイクロ USD の整数のまま見せる (丸めると請求の根拠と食い違う)', () => {
    // 1500 マイクロ USD がしきい値 1000 を超えた文
    const summary = guardrailIncidentSummary(OBSERVATIONS[RuleKind.cost], 1_000, WINDOW_MINUTES);
    expect(summary).toContain('1500');
    expect(summary).toContain('1000');
  });

  it('エラー率は百分率で見せる (0.453 より 45.3% のほうが読み取りやすい)', () => {
    // 45.3% がしきい値 50.0% を…という形
    const summary = guardrailIncidentSummary(
      OBSERVATIONS[RuleKind.error_rate],
      0.5,
      WINDOW_MINUTES,
    );
    expect(summary).toContain('45.3%');
    expect(summary).toContain('50.0%');
  });

  it('品質は下回った側で書き、スコアを小数 2 桁で見せる', () => {
    // 0.42 がしきい値 0.80 を下回った文
    const summary = guardrailIncidentSummary(OBSERVATIONS[RuleKind.quality], 0.8, WINDOW_MINUTES);
    expect(summary).toContain('0.42');
    expect(summary).toContain('0.80');
    expect(summary).toContain('下回');
  });
});
