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
import { RATE_LIMIT_TIER } from '@/lib/api/rate-limit';
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
import { assertWithinBudget } from '@/lib/guardrail/budget';
import { evaluateGuardrailsSafely, QUALITY_RULE_KINDS } from '@/lib/guardrail/evaluate';
import { runEvaluation } from '@/lib/evaluation/runner';
import { resolveUpstreamTarget } from '@/lib/proxy/upstream';
import { evaluationRunCreateSchema, evaluationRunQuerySchema } from '@/lib/validations/evaluation';
import { AgentStatus } from '@/domain/types';
import { evaluationBasisTime } from '@/domain/usage-window';

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
//
// **レート制限を掛ける。** 1 要求でケース数ぶん (最大 EVALUATION_SET_MAX_CASES × 2 回) の
// 上流呼び出しが走るので、掛けないとプロキシに置いた課金の保護をこちらから迂回できる
// (中継の代わりに評価を回せばよいことになる)。**数える単位はテナント** (rateLimitKeyFor) —
// 資格情報ごとにすると、API キーやユーザーを増やすだけで上限が何倍にもなる。
//
// **枠は `fanOut`** — 中継と同じ枠 (毎分 600) では保護にならない。600 要求ぶんの枠は
// この経路では上流呼び出し 24 万回ぶんの枠と同じ意味になるため
// (FAN_OUT_ROUTE_RATE_LIMIT_PER_MINUTE)
export const POST = route(
  async ({ request, principal, repos }) => {
    // execute 権限
    const { tenantId, user } = requireAction(principal, 'execute');
    // 本文を検証する
    const input = await readJsonBody(request, evaluationRunCreateSchema);

    // 評価対象エージェント (自テナントのものだけ。他テナントの id は 404 で隠す)
    const agent = await repos.agents.findById(tenantId, input.agentId);
    if (agent === null) throw notFoundError();
    // 停止中のエージェントは呼び出さない (プロキシ経路と同じ扱い)
    if (agent.status !== AgentStatus.active) {
      throw new ApiError(HTTP_STATUS.FORBIDDEN, API_MESSAGES.agentNotActive);
    }
    // **予算を確かめてから上流を呼ぶ** (中継経路と同じ関数・同じ 403)。
    //
    // **これが無いと予算の強制を「評価を回す」側から迂回できる** — 中継では当月の累計が
    // 予算に達した時点で断られるのに、評価の実行は同じエージェントの provider / model と
    // 同じ資格情報で上流を呼ぶので、1 要求でケース数ぶんの課金を積めてしまう (実測)。
    //
    // **ただし評価そのものの支出は予算に積まれない。** 評価の呼び出しを `UsageEvent` へ
    // 書かないのは ADR-0009 の決定で (利用者の呼び出しと混ぜると日次集計とコスト超過ルールが
    // 評価のたびに跳ねる)、累計を数えるのはその表だから。つまりここで効くのは
    // 「中継で予算を使い切ったエージェントを評価に使わせない」ところまでで、評価の支出自体に
    // 上限は掛からない。プラットフォーム側の支出台帳は ADR-0010 の宿題
    await assertWithinBudget(repos, { tenantId, agent, now: new Date() });

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

    // **保存の直後に品質のガードレールを判定する。** cron 間隔に依存せず
    // 「発火から停止まで ≦ 3 秒」を満たすため（UC-08）。見るのは品質だけで、コストとエラー率は
    // 中継の経路が見る（評価の実行では利用イベントが増えないので、ここで見ても何も動かない）。
    // **判定の失敗で 500 にしない** — 実行はすでに保存されているので、500 にすると
    // 「保存された実行が利用者からは失敗に見える」ことになる
    await evaluateGuardrailsSafely(repos, {
      tenantId,
      agentId: agent.id,
      kinds: QUALITY_RULE_KINDS,
      // **基準時刻は「保存した実行の時刻」と「いま」の遅いほう。** DB の時計がアプリより
      // 進んでいると、窓の終端 (基準時刻の 1 ミリ秒後) が保存した行より前になり、
      // いま採点した結果が集計に入らない (品質ルールが発火しない fail-open)
      now: evaluationBasisTime(saved.run.createdAt, new Date()),
      // 評価を走らせたユーザーを操作主体として残す（自動発火だが起点は人の操作）
      actorId: user.id,
    });

    // 回帰比較の相手 (同じエージェント × セットの直前の実行。初回なら null)
    const previous = await repos.evaluations.findPreviousRun(tenantId, saved.run);
    // 201 で結果を返す
    const body: ApiSchemas['EvaluationRunDetail'] = {
      ...toEvaluationRunDto(saved.run),
      results: saved.results.map(toEvaluationResultDto),
      regression: previous === null ? null : toEvaluationRegressionDto(saved.run, previous),
    };
    return Response.json(body, { status: HTTP_STATUS.CREATED });
  },
  // **認可を先に確かめる**（権限の無い要求でテナントの小さい枠を使い切らせない。
  // 理由は `RouteOptions.requiredAction`）
  { rateLimit: RATE_LIMIT_TIER.fanOut, requiredAction: 'execute' },
);
