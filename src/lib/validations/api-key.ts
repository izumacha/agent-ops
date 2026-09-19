// API キー発行の入力スキーマ (OpenAPI の ApiKeyCreate と一致させる)
import { z } from './zod';
import { resourceId, shortText } from './common';

// 用途名と、任意で紐づけるエージェント。agentId は自由文ではなく資源 id なので id の規則で見る
// (形の違う値をそのまま DB へ渡すと、NUL を含む text を PostgreSQL が拒否して 500 になる)
export const apiKeyCreateSchema = z.strictObject({
  name: shortText,
  agentId: resourceId.optional(),
});
