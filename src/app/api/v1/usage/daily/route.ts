// GET /api/v1/usage/daily — 期間内の利用イベントを UTC の日ごとに集計する (view 権限。Step2)
import { resolveUsageWindow, type UsageWindowError } from '@/domain/usage-window';
import { API_MESSAGES, USAGE_RANGE_MAX_DAYS } from '@/lib/constants';
import type { ApiSchemas } from '@/lib/api-types';
import { validationError } from '@/lib/api/errors';
import { requireAction } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import { parseQuery } from '@/lib/api/pagination';
import { toDailyUsageDto } from '@/lib/api/serializers';
import { usageDailyQuerySchema } from '@/lib/validations/usage';

// 期間を組み立てられなかった理由ごとの文言 (どの理由でも 422。表を 1 つにして分岐を散らさない)
const WINDOW_ERROR_MESSAGES: Readonly<Record<UsageWindowError, string>> = {
  // 読めない日付 (存在しない日も含む)
  invalid_day: API_MESSAGES.invalidUsageDay,
  // 開始と終了が逆
  reversed: API_MESSAGES.reversedUsageRange,
  // 期間が長すぎる
  too_long: API_MESSAGES.usageRangeTooLong,
};

// 日次集計
export const GET = route(async ({ request, principal, repos }) => {
  // 閲覧権限 (view) が要る。テナント条件はここで得た tenantId を必ず使う
  const { tenantId } = requireAction(principal, 'view');
  // クエリ (from / to / agentId) を検証する
  const query = parseQuery(new URL(request.url), usageDailyQuerySchema);
  // 期間を組み立てる (日の境目は UTC。上限を超える指定は拒否する)
  const resolved = resolveUsageWindow(query.from, query.to, USAGE_RANGE_MAX_DAYS);
  // 組み立てられなければ理由に応じた 422
  if (!resolved.ok) {
    throw validationError([{ path: 'from', message: WINDOW_ERROR_MESSAGES[resolved.reason] }]);
  }
  // 集計する (テナントで絞り、指定があればエージェントでも絞る)
  const totals = await repos.usageEvents.dailyTotals(tenantId, {
    start: resolved.window.start,
    endExclusive: resolved.window.endExclusive,
    agentId: query.agentId,
  });
  // OpenAPI の DailyUsageList の形へ写す
  const body: ApiSchemas['DailyUsageList'] = { items: totals.map(toDailyUsageDto) };
  // 200 で返す
  return Response.json(body);
});
