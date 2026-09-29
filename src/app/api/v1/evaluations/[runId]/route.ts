// /api/v1/evaluations/{runId}: 評価実行の詳細 (view)。
// **回帰比較は専用のエンドポイントを作らず、ここに含める** — UC-07 が求めるのは
// 「過去の実行と比べる」ことで、同じエージェント × セットの直前の実行との差があれば足りる
import { requireAction } from '@/lib/api/guard';
import { notFoundError } from '@/lib/api/errors';
import { route } from '@/lib/api/handler';
import {
  toEvaluationRegressionDto,
  toEvaluationResultDto,
  toEvaluationRunDto,
} from '@/lib/api/serializers';
import type { ApiSchemas } from '@/lib/api-types';

// GET /evaluations/{runId} (getEvaluationRun)
export const GET = route<{ runId: string }>(async ({ params, principal, repos }) => {
  // view 権限
  const { tenantId } = requireAction(principal, 'view');
  // 自テナントの実行だけを引く (他テナントの id は null で返る)
  const found = await repos.evaluations.findRun(tenantId, params.runId);
  // 見つからなければ 404 (存在を隠す)
  if (found === null) throw notFoundError();
  // 回帰比較の相手 (初回なら null)
  const previous = await repos.evaluations.findPreviousRun(tenantId, found.run);
  // 実行・ケース単位の結果・直前との差を返す
  const body: ApiSchemas['EvaluationRunDetail'] = {
    ...toEvaluationRunDto(found.run),
    results: found.results.map(toEvaluationResultDto),
    regression: previous === null ? null : toEvaluationRegressionDto(found.run, previous),
  };
  return Response.json(body);
});
