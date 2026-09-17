// /api/v1/users/{userId}/tokens: ログイントークンの一覧・発行 (admin ロール限定。ADR-0005)
import { readJsonBody } from '@/lib/api/body';
import { conflictError, notFoundError } from '@/lib/api/errors';
import { requireAdminRole } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { parsePageQuery } from '@/lib/api/pagination';
import { toListDto, toUserTokenDto } from '@/lib/api/serializers';
import type { ApiSchemas } from '@/lib/api-types';
import { API_MESSAGES } from '@/lib/constants';
import { displayPrefix, generateSecret, hashSecret, userTokenExpiresAt } from '@/lib/tokens';
import { userTokenCreateSchema } from '@/lib/validations/user-token';

// 認証に依存するので静的化しない
export const dynamic = 'force-dynamic';

// GET /users/{userId}/tokens (listUserTokens)
export const GET = route<{ userId: string }>(async ({ request, params, principal, repos }) => {
  // admin ロールであること
  const { tenantId } = requireAdminRole(principal);
  // 対象ユーザー (自テナント内。他テナントは 404)
  const target = await repos.users.findById(tenantId, params.userId);
  if (!target) throw notFoundError();
  // 一覧する (平文は持っていないので漏れようがない)
  const page = await repos.userTokens.list(
    tenantId,
    target.id,
    parsePageQuery(new URL(request.url)),
  );
  // DTO へ写す
  const body: ApiSchemas['UserTokenList'] = toListDto(page, toUserTokenDto);
  return Response.json(body);
});

// POST /users/{userId}/tokens (createUserToken): 平文はこの応答でのみ返す
export const POST = route<{ userId: string }>(async ({ request, params, principal, repos }) => {
  // admin ロールであること
  const { tenantId } = requireAdminRole(principal);
  // 本文を検証する
  const input = await readJsonBody(request, userTokenCreateSchema);
  // 対象ユーザー (自テナント内。他テナントは 404)
  const target = await repos.users.findById(tenantId, params.userId);
  if (!target) throw notFoundError();
  // 無効化されたユーザーには発行しない (発行できても認証で必ず 401 になる「使えない資格情報」を作らない)
  if (target.disabledAt !== null) throw conflictError(API_MESSAGES.userDisabled);
  // 平文を生成し、ハッシュだけを保存する
  const secret = generateSecret('user');
  const token = await repos.userTokens.create({
    tenantId,
    userId: target.id,
    prefix: displayPrefix(secret),
    tokenHash: hashSecret(secret),
    name: input.name,
    expiresAt: userTokenExpiresAt(input.expiresInDays),
  });
  if (!token) throw notFoundError();
  // 平文を添えて 201 で返す
  const body: ApiSchemas['UserTokenIssued'] = { ...toUserTokenDto(token), secret };
  return Response.json(body, { status: HTTP_STATUS.CREATED });
});
