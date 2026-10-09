// /api/v1/maintenance/run: 保守の定期実行の受け口（プラットフォーム管理者のみ）。ADR-0016
//
// **スケジューラから叩く 1 本。** 中身は 2 つで、どちらも「誰も呼ばない後片付け」だった
// （ガードレールの定期掃き＝ADR-0010 の宿題、レート制限の記録の回収＝ADR-0015 の宿題）。
// 理由と設計は `src/lib/maintenance/run.ts` が持つ。
//
// **プラットフォーム限定にしてある。** テナントをまたいで読むので RBAC の 3 役割では表せない
// （テナント内の admin に配備全体の掃きを許すとクロステナントの読み出しになる）。
//
// **GET ではなく POST。** 発火すればインシデントを作りエージェントを止め、記録を消すので
// 副作用がある（§9「副作用のある操作を GET で行わない」）。**Vercel Cron は GET しか
// 発行しない**ので、あちらのネイティブ cron からは呼べない — スケジューラは
// `scripts/maintenance-tick.mjs` を外部から回す形にしてある（`docs/deploy.md`）。
//
// **レート制限は掛けない**（他のプラットフォーム経路と同じ）。枠はプランから引くので
// プランを持たない主体には倒れ先が無く、しかも**一巡はカーソルで何十回も呼ぶ**形なので
// 小さい枠を掛けると掃きが途中で止まる（`OUTBOUND_WAIT_ROUTE_RATE_LIMIT_PER_MINUTE` の
// コメントが記録している失敗の形と同じ）。叩けるのは運用者のトークンだけ。
import { readJsonBody } from '@/lib/api/body';
import { requirePlatformAdmin } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import type { ApiSchemas } from '@/lib/api-types';
import { runMaintenance } from '@/lib/maintenance/run';
import { maintenanceRunSchema } from '@/lib/validations/maintenance';

// POST /maintenance/run (runMaintenance)
export const POST = route(async ({ request, principal, repos }) => {
  // プラットフォーム管理者のみ（テナントをまたいで読むので）
  requirePlatformAdmin(principal);
  // 本文を検証する（続きの位置と 1 要求ぶんの予算）
  const input = await readJsonBody(request, maintenanceRunSchema);
  // 1 要求ぶんだけ進める
  const result = await runMaintenance(repos, {
    tenantCursor: input.tenantCursor,
    agentCursor: input.agentCursor,
    agentBudget: input.agentBudget,
    // 判定の基準時刻（集計窓の終端）
    now: new Date(),
  });
  // 進み具合と続きの位置を返す。
  // **`failed` が 0 でなくても 200 を返す**（明示実行の `POST /guardrails/run` とは逆）。
  // あちらは「人がいま判定しろと言った操作」なので隠さず 500 にするが、こちらは**一巡を
  // 回し切ること自体が仕事**で、500 にすると呼び出し側のループが続きのカーソルを受け取れず
  // **そのテナント以降が丸ごと判定されない**。件数を応答に載せることで運用者には見える
  // （サーバログにも `guardrail.evaluation_failed` が 1 行ずつ残っている）
  const body: ApiSchemas['MaintenanceRunResult'] = {
    rateLimitHitsDeleted: result.rateLimitHitsDeleted,
    rateLimitSweepComplete: result.rateLimitSweepComplete,
    agentsEvaluated: result.agentsEvaluated,
    rulesEvaluated: result.rulesEvaluated,
    fired: result.fired,
    failed: result.failed,
    passComplete: result.passComplete,
    nextTenantCursor: result.nextTenantCursor,
    nextAgentCursor: result.nextAgentCursor,
  };
  return Response.json(body);
});
