// ガードレールのルール登録と明示実行の入力検証。
//
// **しきい値と集計窓の範囲の規則は `src/domain/guardrail/rule.ts` が唯一の源**で、ここはそれを
// 読んで Zod の形にするだけ。数値を書き写すと、入力検証と DB の CHECK 制約と判定の 3 か所が
// 別々の範囲を持つことになる（しかも通る範囲が広い方だけが実際に効く）。
import { z } from './zod';
import { resourceId } from './common';
import { isValidWindowMinutes, thresholdRangeFor } from '@/domain/guardrail/rule';
import { IncidentStatus, RuleAction, RuleKind } from '@/domain/types';
import { pageQuerySchema } from '@/lib/api/pagination';
import {
  API_MESSAGES,
  GUARDRAIL_COST_THRESHOLD_MAX,
  GUARDRAIL_WINDOW_MAX_MINUTES,
  GUARDRAIL_WINDOW_MIN_MINUTES,
} from '@/lib/constants';

// ルールの種別（正準は src/domain/types.ts）
const ruleKind = z.enum(Object.values(RuleKind));
// 発火したときの動作
const ruleAction = z.enum(Object.values(RuleAction));

/**
 * ルール登録の本文。
 *
 * **しきい値の範囲は種別ごとに違う**ので、項目単位では確かめられない（コストはマイクロ USD の
 * 整数で上限が 2^53-1、エラー率と品質は 0〜1）。そこで `superRefine` で「種別が決まってから」
 * 範囲を見る。種別を足すと `thresholdRangeFor` が網羅性で守るので、ここに分岐は増えない。
 */
export const guardrailRuleCreateSchema = z
  .strictObject({
    // 対象エージェント。省略・null はテナント全体へ掛かる
    agentId: resourceId.nullable().optional(),
    // 種別（この値でしきい値の範囲が決まる）
    kind: ruleKind,
    // しきい値（範囲は下の superRefine が種別ごとに見る）
    threshold: z.number(),
    // 集計窓の長さ（分）。規則は述語 1 つを共有する
    windowMinutes: z.number(),
    // 発火したときの動作
    action: ruleAction,
  })
  .superRefine((value, ctx) => {
    // その種別で許されるしきい値の範囲（上限はコストだけ金額の上限に合わせる）
    const range = thresholdRangeFor(value.kind, GUARDRAIL_COST_THRESHOLD_MAX);
    // 範囲外は 422（どの項目かを添える）
    if (value.threshold < range.min || value.threshold > range.max) {
      ctx.addIssue({
        code: 'custom',
        path: ['threshold'],
        message: API_MESSAGES.guardrailThresholdOutOfRange,
      });
    }
    // コスト以外は「整数でなくてよい」が、コストはマイクロ USD の整数なので整数だけを許す
    if (value.kind === RuleKind.cost && !Number.isInteger(value.threshold)) {
      ctx.addIssue({
        code: 'custom',
        path: ['threshold'],
        message: API_MESSAGES.guardrailThresholdOutOfRange,
      });
    }
    // 集計窓は述語が決める（整数・下限・上限をまとめて見る）
    if (
      !isValidWindowMinutes(
        value.windowMinutes,
        GUARDRAIL_WINDOW_MIN_MINUTES,
        GUARDRAIL_WINDOW_MAX_MINUTES,
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['windowMinutes'],
        message: API_MESSAGES.guardrailWindowOutOfRange,
      });
    }
  });

/**
 * インシデント一覧のクエリ（limit / cursor に絞り込みを足す）。
 * **1 つのスキーマで検証する**ので、複数の誤りを 1 応答の issues でまとめて返せる
 */
export const incidentListQuerySchema = pageQuerySchema.extend({
  // エージェントで絞る（指定が無ければテナント全体）
  agentId: resourceId.optional(),
  // 状態で絞る（open / resolved）
  status: z.enum(Object.values(IncidentStatus)).optional(),
});

/** 明示実行の本文（どのエージェントを判定するか） */
export const guardrailRunSchema = z.strictObject({
  // 判定対象のエージェント（自テナントのもの。見つからなければ 404）
  agentId: resourceId,
});

/** 検証済みのルール登録の本文 */
export type GuardrailRuleCreateBody = z.infer<typeof guardrailRuleCreateSchema>;
/** 検証済みの明示実行の本文 */
export type GuardrailRunBody = z.infer<typeof guardrailRunSchema>;
