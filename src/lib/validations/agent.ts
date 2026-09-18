// エージェント登録・更新の入力スキーマ (OpenAPI の AgentCreate / AgentUpdate と一致させる)
import { z } from './zod';
import { longText, microUsd, provider, shortText } from './common';
import { API_MESSAGES } from '@/lib/constants';

// 登録 (省略した description / budgetMicroUsd は未設定)
export const agentCreateSchema = z.strictObject({
  name: shortText,
  description: longText.optional(),
  provider,
  model: shortText,
  budgetMicroUsd: microUsd.optional(),
});

// 更新 (省略したプロパティは変更しない。null は未設定へ戻す)
export const agentUpdateSchema = z
  .strictObject({
    name: shortText.optional(),
    description: longText.nullable().optional(),
    model: shortText.optional(),
    budgetMicroUsd: microUsd.nullable().optional(),
  })
  // 1 つも指定が無い本文は受けない (何も変えない更新で updatedAt だけが進み、Step4 の監査ログにも残ってしまう)
  .refine((patch) => Object.keys(patch).length > 0, { message: API_MESSAGES.emptyPatch });
