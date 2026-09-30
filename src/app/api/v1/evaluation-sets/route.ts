// /api/v1/evaluation-sets: 評価セットの一覧 (view) と作成 (execute)。UC-07
import { readJsonBody } from '@/lib/api/body';
import { requireAction } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { pageQuerySchema, parseQuery } from '@/lib/api/pagination';
import { toEvaluationCaseDto, toEvaluationSetDto, toListDto } from '@/lib/api/serializers';
import type { ApiSchemas } from '@/lib/api-types';
import { evaluationSetCreateSchema } from '@/lib/validations/evaluation';

// GET /evaluation-sets (listEvaluationSets)
export const GET = route(async ({ request, principal, repos }) => {
  // view 権限。テナント条件はここで得た tenantId を必ず使う
  const { tenantId } = requireAction(principal, 'view');
  // limit / cursor を検証する
  const pageQuery = parseQuery(new URL(request.url), pageQuerySchema);
  // 自テナントで絞って一覧する
  const page = await repos.evaluations.listSets(tenantId, pageQuery);
  // DTO へ写す
  const body: ApiSchemas['EvaluationSetList'] = toListDto(page, toEvaluationSetDto);
  return Response.json(body);
});

// POST /evaluation-sets (createEvaluationSet)
export const POST = route(async ({ request, principal, repos }) => {
  // execute 権限
  const { tenantId } = requireAction(principal, 'execute');
  // 本文を検証する (ケースは 1 件以上・上限まで)
  const input = await readJsonBody(request, evaluationSetCreateSchema);
  // 自テナントに作る (名前重複は DuplicateError → 422)
  const created = await repos.evaluations.createSet({
    tenantId,
    name: input.name,
    // 期待する出力は省略可なので null に正規化する (未設定の表現を 1 つにする)
    cases: input.cases.map((item) => ({ input: item.input, expected: item.expected ?? null })),
  });
  // 201 でセットとケースを返す
  const body: ApiSchemas['EvaluationSetDetail'] = {
    ...toEvaluationSetDto(created.set),
    cases: created.cases.map(toEvaluationCaseDto),
  };
  return Response.json(body, { status: HTTP_STATUS.CREATED });
});
