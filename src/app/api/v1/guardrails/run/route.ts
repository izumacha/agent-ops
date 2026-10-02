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
import { RATE_LIMIT_TIER } from '@/lib/api/rate-limit';
import type { ApiSchemas } from '@/lib/api-types';
import { evaluateGuardrails } from '@/lib/guardrail/evaluate';
import { guardrailRunSchema } from '@/lib/validations/guardrail';
import { RuleKind } from '@/domain/types';

// 全種別を見る (明示実行は「いま止まるべきか」を網羅的に確かめる操作なので絞らない)。
// **enum から導く**ので、種別を足したときにここへ書き足す必要が無い
const ALL_RULE_KINDS: readonly RuleKind[] = Object.values(RuleKind);

// POST /guardrails/run (runGuardrails)
//
// **レート制限は `outbound` の枠で掛ける。** この経路は 1 要求で (a) 有効ルールの読み出し、
// (b) 種別ごとの集計クエリ、(c) 発火すればインシデント・監査ログの書き込み、
// (d) **応答を返す前に待つ通知の往復** まで行う。中継と同じ枠 (毎分 600) で数えると、
// 1 要求の重さが違う経路に同じ上限を当てることになる。
//
// 通知を待つのは自動実行と違ってここが「人が結果を見る操作」だから。待つ代わりに外部の
// 応答時間がこの API の応答時間に乗るので、**枠を絞るのは通知の往復に対する歯止めも兼ねる**。
//
// **評価の実行 (`fanOut`) とは別の枠にする。** こちらは上流 LLM を呼ばないので課金は増えず、
// 妥当な上限も違う。同じ枠にすると、**1 要求 1 エージェント**であるこの経路では
// cron からの定期掃きが成り立たなくなる (エージェント 20 件のテナントの毎分の掃きは 20 要求で、
// 6 件で止まると残りはその回は一度も判定されない = backstop が静かに効かなくなる)
export const POST = route(
  async ({ request, principal, repos }) => {
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
  },
  // **認可を先に確かめる**（権限の無い要求でテナントの小さい枠を使い切らせない。
  // 理由は `RouteOptions.requiredAction`）
  { rateLimit: RATE_LIMIT_TIER.outbound, requiredAction: 'stop' },
);
