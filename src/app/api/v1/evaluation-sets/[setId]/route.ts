// /api/v1/evaluation-sets/{setId}: 評価セットの詳細 (view)。ケースは position 昇順で返す
import { requireAction } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import { notFoundError } from '@/lib/api/errors';
import { toEvaluationCaseDto, toEvaluationSetDto } from '@/lib/api/serializers';
import type { ApiSchemas } from '@/lib/api-types';

// GET /evaluation-sets/{setId} (getEvaluationSet)
export const GET = route<{ setId: string }>(async ({ params, principal, repos }) => {
  // view 権限
  const { tenantId } = requireAction(principal, 'view');
  // 自テナントのセットだけを引く (他テナントの id は null で返る)
  const found = await repos.evaluations.findSet(tenantId, params.setId);
  // 見つからなければ 404 (存在を隠す)
  if (found === null) throw notFoundError();
  // セットとケースを返す
  const body: ApiSchemas['EvaluationSetDetail'] = {
    ...toEvaluationSetDto(found.set),
    cases: found.cases.map(toEvaluationCaseDto),
  };
  return Response.json(body);
});
