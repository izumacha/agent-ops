// /api/v1/api-keys: API キーの一覧 (view) と発行 (execute)。UC-04。平文は発行応答でのみ返す
import { validationError } from '@/lib/api/errors';
import { readJsonBody } from '@/lib/api/body';
import { requireAction } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { parsePageQuery } from '@/lib/api/pagination';
import { toListDto, toApiKeyDto } from '@/lib/api/serializers';
import type { ApiSchemas } from '@/lib/api-types';
import { API_MESSAGES } from '@/lib/constants';
import { issueSecret } from '@/lib/tokens';
import { apiKeyCreateSchema } from '@/lib/validations/api-key';

// GET /api-keys (listApiKeys)
export const GET = route(async ({ request, principal, repos }) => {
  // view 権限
  const { tenantId } = requireAction(principal, 'view');
  // 自テナントで絞って一覧する (失効済みも含む)
  const page = await repos.apiKeys.list(tenantId, parsePageQuery(new URL(request.url)));
  // DTO へ写す (ハッシュは載らない)
  const body: ApiSchemas['ApiKeyList'] = toListDto(page, toApiKeyDto);
  return Response.json(body);
});

// POST /api-keys (createApiKey)
export const POST = route(async ({ request, principal, repos }) => {
  // execute 権限
  const { tenantId } = requireAction(principal, 'execute');
  // 本文を検証する
  const input = await readJsonBody(request, apiKeyCreateSchema);
  // 平文を発行し、ハッシュだけを保存する
  const issued = issueSecret('apiKey');
  const key = await repos.apiKeys.create({
    tenantId,
    agentId: input.agentId ?? null,
    prefix: issued.prefix,
    keyHash: issued.hash,
    name: input.name,
  });
  // 指定したエージェントが自テナントに無ければ入力エラー (他テナントの id も同じ応答で存在を隠す)
  if (!key) throw validationError([{ path: 'agentId', message: API_MESSAGES.agentNotInTenant }]);
  // 平文を添えて 201 で返す
  const body: ApiSchemas['ApiKeyIssued'] = { ...toApiKeyDto(key), secret: issued.secret };
  return Response.json(body, { status: HTTP_STATUS.CREATED });
});
