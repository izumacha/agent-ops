// /api/v1/api-keys: API キーの一覧 (view) と発行 (execute)。UC-04。平文は発行応答でのみ返す
import { ApiError } from '@/lib/api/errors';
import { readJsonBody } from '@/lib/api/body';
import { requireAction } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import { parsePageQuery } from '@/lib/api/pagination';
import { toApiKeyDto } from '@/lib/api/serializers';
import type { ApiSchemas } from '@/lib/api-types';
import { API_MESSAGES } from '@/lib/constants';
import { displayPrefix, generateSecret, hashSecret } from '@/lib/tokens';
import { apiKeyCreateSchema } from '@/lib/validations/api-key';

// 認証に依存するので静的化しない
export const dynamic = 'force-dynamic';
// 入力検証エラー
const UNPROCESSABLE = 422;

// GET /api-keys (listApiKeys)
export const GET = route(async ({ request, principal, repos }) => {
  // view 権限
  const { tenantId } = requireAction(principal, 'view');
  // 自テナントで絞って一覧する (失効済みも含む)
  const page = await repos.apiKeys.list(tenantId, parsePageQuery(new URL(request.url)));
  // DTO へ写す (ハッシュは載らない)
  const body: ApiSchemas['ApiKeyList'] = {
    items: page.items.map(toApiKeyDto),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
  return Response.json(body);
});

// POST /api-keys (createApiKey)
export const POST = route(async ({ request, principal, repos }) => {
  // execute 権限
  const { tenantId } = requireAction(principal, 'execute');
  // 本文を検証する
  const input = await readJsonBody(request, apiKeyCreateSchema);
  // 平文を生成し、ハッシュだけを保存する
  const secret = generateSecret('apiKey');
  const key = await repos.apiKeys.create({
    tenantId,
    agentId: input.agentId ?? null,
    prefix: displayPrefix(secret),
    keyHash: hashSecret(secret),
    name: input.name,
  });
  // 指定したエージェントが自テナントに無ければ入力エラー (他テナントの id も同じ応答で存在を隠す)
  if (!key) {
    throw new ApiError(UNPROCESSABLE, API_MESSAGES.validation, [
      { path: 'agentId', message: API_MESSAGES.agentNotInTenant },
    ]);
  }
  // 平文を添えて 201 で返す
  const body: ApiSchemas['ApiKeyIssued'] = { ...toApiKeyDto(key), secret };
  return Response.json(body, { status: 201 });
});
