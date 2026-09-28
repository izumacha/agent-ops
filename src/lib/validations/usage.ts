// 日次集計のクエリ (?from=&to=&agentId=) の検証。期間の規則そのものは @/domain/usage-window が持つ
import { z } from './zod';
import { resourceId } from './common';
import { API_MESSAGES } from '@/lib/constants';

// 'YYYY-MM-DD' の形だけを受ける (実在する日付かどうかは期間を組み立てるときに見る)
const usageDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: API_MESSAGES.invalidUsageDay });

// 日次集計のクエリ (期間は必須。無指定の全期間は全件走査になるので許さない)
export const usageDailyQuerySchema = z.object({
  // 集計の開始日 (含む)
  from: usageDay,
  // 集計の終了日 (含む)
  to: usageDay,
  // エージェントで絞る (省略時はテナント全体)
  agentId: resourceId.optional(),
});
