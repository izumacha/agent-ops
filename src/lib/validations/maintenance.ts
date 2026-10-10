// 保守の定期実行（`POST /maintenance/run`。ADR-0016）の入力検証。
//
// **上限の値は `src/lib/constants.ts` が唯一の源**で、ここはそれを読んで Zod の形にするだけ
// （数値を書き写すと、入力検証と本体の予算が別々の上限を持つことになる）。
import { z } from './zod';
import { cursorSchema } from '@/lib/api/pagination';
import { MAINTENANCE_AGENT_BUDGET_DEFAULT, MAINTENANCE_AGENT_BUDGET_MAX } from '@/lib/constants';

/**
 * 保守の定期実行の本文。
 *
 * **カーソルは 2 つある。** テナントの位置とそのテナントの中のエージェントの位置で、
 * 前回応答の `nextTenantCursor` / `nextAgentCursor` をそのまま送り返す
 * （`null` なら送らない＝そこは先頭から）。**1 本に畳まない** — 畳むと符号化の規則を
 * 自分で作ることになり、既存のカーソルの復号（`decodeCursor`）と 2 つの形が並ぶ。
 *
 * **`agentBudget` は「1 要求で判定するエージェント数」**で、省略すると既定値。
 * 大きくするほど 1 要求が長くなるので上限を置く（超過は 422）。
 */
export const maintenanceRunSchema = z.strictObject({
  // 続きのテナント（前回応答の nextTenantCursor。省略すると先頭から＝新しい一巡の開始）
  tenantCursor: cursorSchema.optional(),
  // 続きのエージェント（前回応答の nextAgentCursor。省略するとそのテナントの先頭から）
  agentCursor: cursorSchema.optional(),
  // この要求で判定するエージェント数の上限（1〜最大値の整数。省略時は既定値）
  agentBudget: z
    .number()
    .int()
    .min(1)
    .max(MAINTENANCE_AGENT_BUDGET_MAX)
    .default(MAINTENANCE_AGENT_BUDGET_DEFAULT),
});

/** 検証済みの保守の定期実行の本文 */
export type MaintenanceRunBody = z.infer<typeof maintenanceRunSchema>;
