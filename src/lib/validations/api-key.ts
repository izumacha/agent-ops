// API キー発行の入力スキーマ (OpenAPI の ApiKeyCreate と一致させる)
import { z } from 'zod';
import { shortText } from './common';

// 用途名と、任意で紐づけるエージェント
export const apiKeyCreateSchema = z.object({
  name: shortText,
  agentId: shortText.optional(),
});
// 検証後の型
export type ApiKeyCreateInput = z.infer<typeof apiKeyCreateSchema>;
