// エージェント登録・更新の入力スキーマ (OpenAPI の AgentCreate / AgentUpdate と一致させる)
import { z } from './zod';
import { longText, microUsd, provider, shortText } from './common';

// 登録 (省略した description / budgetMicroUsd は未設定)
export const agentCreateSchema = z.object({
  name: shortText,
  description: longText.optional(),
  provider,
  model: shortText,
  budgetMicroUsd: microUsd.optional(),
});
// 検証後の型
export type AgentCreateInput = z.infer<typeof agentCreateSchema>;

// 更新 (省略したプロパティは変更しない。null は未設定へ戻す)
export const agentUpdateSchema = z.object({
  name: shortText.optional(),
  description: longText.nullable().optional(),
  model: shortText.optional(),
  budgetMicroUsd: microUsd.nullable().optional(),
});
// 検証後の型
export type AgentUpdateInput = z.infer<typeof agentUpdateSchema>;
