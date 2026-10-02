// /api/v1/guardrails/run: ガードレールの明示実行 (stop 権限)。UC-08
//
// **通常は中継と評価実行の直後に自動で走る。** この経路は (a) cron からの定期実行、
// (b) 運用者が「いま止まるべきか」を確かめる操作、の 2 つに使う。判定の中身は自動実行と
// まったく同じ関数 (src/lib/guardrail/evaluate.ts) を通る — 別経路を書くと「cron では
// 発火するのに中継では発火しない」ような食い違いが生まれる。
import { readJsonBody } from '@/lib/api/body';
import { notFoundError } from '@/lib/api/errors';
import { requireAction } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import type { ApiSchemas } from '@/lib/api-types';
import { evaluateGuardrails } from '@/lib/guardrail/evaluate';
import { guardrailRunSchema } from '@/lib/validations/guardrail';
import { RuleKind } from '@/domain/types';

// 全種別を見る (明示実行は「いま止まるべきか」を網羅的に確かめる操作なので絞らない)。
// **enum から導く**ので、種別を足したときにここへ書き足す必要が無い
const ALL_RULE_KINDS: readonly RuleKind[] = Object.values(RuleKind);

// POST /guardrails/run (runGuardrails)
export const POST = route(async ({ request, principal, repos }) => {
  // stop 権限 (発火すると停止しうるので、停止と同じ権限を要求する)
  const { tenantId, user } = requireAction(principal, 'stop');
  // 本文を検証する
  const input = await readJsonBody(request, guardrailRunSchema);
  // 対象エージェントが自テナントに居ること (他テナントの id は 404 で隠す)
  const agent = await repos.agents.findById(tenantId, input.agentId);
  if (agent === null) throw notFoundError();
  // **自動実行と同じ関数を通す。** ここは fail-safe の包みを使わない —
  // 利用者が明示的に「判定しろ」と言った操作なので、判定できなかったことは隠さず 500 にする
  // (自動実行で包むのは「すでに成立した操作の答えを変えないため」で、事情が逆)
  const result = await evaluateGuardrails(repos, {
    tenantId,
    agentId: agent.id,
    kinds: ALL_RULE_KINDS,
    now: new Date(),
    // 人が起点の操作なので、その利用者を操作主体として監査ログへ残す
    actorId: user.id,
  });
  // 判定した件数と発火したものを返す
  const body: ApiSchemas['GuardrailRunResult'] = {
    evaluated: result.evaluated,
    fired: result.fired.map((row) => ({
      ruleId: row.ruleId,
      kind: row.kind,
      action: row.action,
      incidentId: row.incidentId,
      suspended: row.suspended,
      // 新しい行を作ったか（false なら incidentId は既に開いていた行を指す）
      created: row.created,
    })),
  };
  return Response.json(body);
});
