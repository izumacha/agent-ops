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
import { issueUserToken } from '@/lib/tokens';
import { userTokenCreateSchema } from '@/lib/validations/user-token';

// GET /users/{userId}/tokens (listUserTokens)
export const GET = route<{ userId: string }>(async ({ request, params, principal, repos }) => {
  // admin ロールであること
  const { tenantId } = requireAdminRole(principal);
  // ページ指定を先に検証する (他の一覧と同じく、不正な limit / cursor は対象の有無より先に 422)
  const query = parsePageQuery(new URL(request.url));
  // 対象ユーザー (自テナント内。他テナントは 404)
  const target = await repos.users.findById(tenantId, params.userId);
  if (!target) throw notFoundError();
  // 一覧する (平文は持っていないので漏れようがない)
  const page = await repos.userTokens.list(tenantId, target.id, query);
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
  // 平文を発行し、ハッシュだけを保存する。発行先の存在 (自テナント内) と有効/無効の判定はデータ層が原子的に行う
  const issued = issueUserToken(input.name, input.expiresInDays);
  const result = await repos.userTokens.create({
    tenantId,
    userId: params.userId,
    // 発行の一式は展開せず 1 項目ずつ書き写す (展開を後ろに置くと、将来 input に tenantId や
    // userId が増えたとき呼び出し側の指定を黙って上書きする)
    prefix: issued.input.prefix,
    tokenHash: issued.input.tokenHash,
    name: issued.input.name,
    expiresAt: issued.input.expiresAt,
  });
  // 他テナント・存在しないユーザーは 404
  if (result.status === 'not_found') throw notFoundError();
  // 無効化されたユーザーには発行しない (発行できても認証で必ず 401 になる「使えない資格情報」を作らない)
  if (result.status === 'disabled') throw conflictError(API_MESSAGES.userDisabled);
  // 平文を添えて 201 で返す
  const body: ApiSchemas['UserTokenIssued'] = {
    ...toUserTokenDto(result.token),
    secret: issued.secret,
  };
  return Response.json(body, { status: HTTP_STATUS.CREATED });
});
