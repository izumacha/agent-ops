// /api/v1/tenants: テナントの一覧・作成 (プラットフォーム管理者のみ。テナント境界の外側)
import { requirePlatformAdmin } from '@/lib/api/guard';
import { readJsonBody } from '@/lib/api/body';
import { route } from '@/lib/api/handler';
import { parsePageQuery } from '@/lib/api/pagination';
import { toTenantDto, toUserDto, toUserTokenDto } from '@/lib/api/serializers';
import type { ApiSchemas } from '@/lib/api-types';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { USER_TOKEN_BOOTSTRAP_NAME, USER_TOKEN_DEFAULT_TTL_DAYS } from '@/lib/constants';
import { displayPrefix, generateSecret, hashSecret, userTokenExpiresAt } from '@/lib/tokens';
import { tenantCreateSchema } from '@/lib/validations/tenant';

// 認証に依存するので静的化しない
export const dynamic = 'force-dynamic';

// GET /tenants: 一覧 (listTenants)
export const GET = route(async ({ request, principal, repos }) => {
  // プラットフォーム管理者だけ
  requirePlatformAdmin(principal);
  // ページ指定を読む
  const page = await repos.tenants.list(parsePageQuery(new URL(request.url)));
  // DTO へ写して返す
  const body: ApiSchemas['TenantList'] = {
    items: page.items.map(toTenantDto),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
  return Response.json(body);
});

// POST /tenants: 作成 (createTenant)。最初の admin とそのトークンも同時に作る (UC-01)
export const POST = route(async ({ request, principal, repos }) => {
  // プラットフォーム管理者だけ
  requirePlatformAdmin(principal);
  // 本文を検証する
  const input = await readJsonBody(request, tenantCreateSchema);
  // admin のログイントークンを生成する (平文はこの応答でのみ返す)
  const secret = generateSecret('user');
  // 3 行を原子的に作る
  const created = await repos.tenants.createWithAdmin({
    name: input.name,
    admin: { email: input.adminEmail, name: input.adminName },
    token: {
      prefix: displayPrefix(secret),
      tokenHash: hashSecret(secret),
      name: USER_TOKEN_BOOTSTRAP_NAME,
      expiresAt: userTokenExpiresAt(USER_TOKEN_DEFAULT_TTL_DAYS),
    },
  });
  // DTO へ写し、平文を添えて 201 で返す
  const body: ApiSchemas['TenantCreated'] = {
    tenant: toTenantDto(created.tenant),
    admin: toUserDto(created.admin),
    adminToken: { ...toUserTokenDto(created.token), secret },
  };
  return Response.json(body, { status: HTTP_STATUS.CREATED });
});
