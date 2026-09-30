// /api/v1/evaluations: 評価実行の一覧 (view) と実行 (execute)。UC-07
//
// 実行は **2 段** で進む (docs/adr/0009-llm-as-judge-evaluation.md):
//   1. 評価対象エージェントの provider/model へケースの入力を投げ、応答を得る
//   2. その応答を judge にバッチで採点させる
// どちらの段が失敗してもケース単位の除外に落として続行し、**実行の記録は必ず 1 行残す**
// (「上流を呼んだのに台帳に無い」状態を作らない。Step2 の利用イベントと同じ考え方)
import { requireAction } from '@/lib/api/guard';
import { readJsonBody } from '@/lib/api/body';
import { ApiError, notFoundError } from '@/lib/api/errors';
import { route } from '@/lib/api/handler';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { pageQuerySchema, parseQuery } from '@/lib/api/pagination';
import {
  toEvaluationRegressionDto,
  toEvaluationResultDto,
  toEvaluationRunDto,
  toListDto,
} from '@/lib/api/serializers';
import type { ApiSchemas } from '@/lib/api-types';
import { API_MESSAGES } from '@/lib/constants';
import { resolveJudgeIdentity } from '@/lib/evaluation/judge';
import { runEvaluation } from '@/lib/evaluation/runner';
import { resolveUpstreamTarget } from '@/lib/proxy/upstream';
import { evaluationRunCreateSchema, evaluationRunQuerySchema } from '@/lib/validations/evaluation';
import { AgentStatus } from '@/domain/types';

// 一覧のクエリ (limit / cursor に agentId / setId を足す)。1 つのスキーマで検証し、
// 複数の誤りを 1 応答の issues で返す (一覧ルートの既存の書き方にそろえる)
const runListQuerySchema = pageQuerySchema.extend(evaluationRunQuerySchema.shape);

// この経路が動いてよい秒数 (Next.js のルートセグメント設定。配備先の関数タイムアウトへ渡る)。
// **既定のままにしない** — 評価は 1 リクエストの中でケース数ぶんの上流往復を待つので、
// 既定 (配備先により数十秒) だと大きなセットで途中打ち切りになり、
// 上流には課金されたのに実行の記録が 1 行も残らない。
// ただしこれは**時間を延ばすだけで、完了を保証しない** (残る境界は ADR-0009)
export const maxDuration = 300;

// GET /evaluations (listEvaluationRuns)
export const GET = route(async ({ request, principal, repos }) => {
  // view 権限。テナント条件はここで得た tenantId を必ず使う
  const { tenantId } = requireAction(principal, 'view');
  // クエリをまとめて検証する
  const { agentId, setId, ...pageQuery } = parseQuery(new URL(request.url), runListQuerySchema);
  // 自テナントで絞って一覧する
  const page = await repos.evaluations.listRuns(tenantId, pageQuery, { agentId, setId });
  // DTO へ写す
  const body: ApiSchemas['EvaluationRunList'] = toListDto(page, toEvaluationRunDto);
  return Response.json(body);
});

// POST /evaluations (runEvaluation)
export const POST = route(async ({ request, principal, repos }) => {
  // execute 権限
  const { tenantId } = requireAction(principal, 'execute');
  // 本文を検証する
  const input = await readJsonBody(request, evaluationRunCreateSchema);

  // 評価対象エージェント (自テナントのものだけ。他テナントの id は 404 で隠す)
  const agent = await repos.agents.findById(tenantId, input.agentId);
  if (agent === null) throw notFoundError();
  // 停止中のエージェントは呼び出さない (プロキシ経路と同じ扱い)
  if (agent.status !== AgentStatus.active) {
    throw new ApiError(HTTP_STATUS.FORBIDDEN, API_MESSAGES.agentNotActive);
  }
  // 使う評価セット (同じく自テナントのものだけ)
  const set = await repos.evaluations.findSet(tenantId, input.setId);
  if (set === null) throw notFoundError();

  // どの judge が採点するか (環境変数の綴り間違いは既定へ倒さず 503 にする)
  const judge = resolveJudgeIdentity();
  if (judge === null) {
    throw new ApiError(HTTP_STATUS.SERVICE_UNAVAILABLE, API_MESSAGES.judgeNotConfigured);
  }
  // **judge の接続先と資格情報も「1 段目を走らせる前」に確かめる。** 設定が無ければ 503 が飛ぶ。
  // ここを省くと、judge が使えないことが分かるのは 2 段目に入ってからになり、
  // それまでに 1 段目でケース数ぶんの上流呼び出し (= 課金) を済ませてしまう。
  // 結果は全件 judge_unavailable で failed になるので、払った分は 1 つのスコアにもならない
  resolveUpstreamTarget(judge.provider);

  // 実行する (上流の失敗はケース単位の除外になって返る)
  const outcome = await runEvaluation({
    agent: { provider: agent.provider, model: agent.model },
    judge,
    cases: set.cases.map((row) => ({
      caseId: row.id,
      input: row.input,
      expected: row.expected,
    })),
  });

  // 結果を保存する (実行・ケース単位の結果を 1 つのトランザクションで)
  const saved = await repos.evaluations.createRun({
    tenantId,
    agentId: agent.id,
    setId: set.set.id,
    accuracy: outcome.totals.accuracy,
    safety: outcome.totals.safety,
    deviation: outcome.totals.deviation,
    status: outcome.status,
    scoredCases: outcome.totals.scoredCases,
    excludedCases: outcome.totals.excludedCases,
    judgeProvider: judge.provider,
    judgeModel: judge.model,
    // 採点できたケースはスコアを、除外したケースは理由を持つ (両立しないことは DB の CHECK も守る)
    results: outcome.verdicts.map((verdict) =>
      verdict.scored
        ? {
            caseId: verdict.caseId,
            accuracy: verdict.scores.accuracy,
            safety: verdict.scores.safety,
            deviation: verdict.scores.deviation,
            excludedReason: null,
          }
        : {
            caseId: verdict.caseId,
            accuracy: null,
            safety: null,
            deviation: null,
            excludedReason: verdict.reason,
          },
    ),
  });
  // 保存できなければ、実行のあいだにエージェントかセットが消えている (404 で隠す)
  if (saved === null) throw notFoundError();

  // 回帰比較の相手 (同じエージェント × セットの直前の実行。初回なら null)
  const previous = await repos.evaluations.findPreviousRun(tenantId, saved.run);
  // 201 で結果を返す
  const body: ApiSchemas['EvaluationRunDetail'] = {
    ...toEvaluationRunDto(saved.run),
    results: saved.results.map(toEvaluationResultDto),
    regression: previous === null ? null : toEvaluationRegressionDto(saved.run, previous),
  };
  return Response.json(body, { status: HTTP_STATUS.CREATED });
});
