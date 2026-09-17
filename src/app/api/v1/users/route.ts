// /api/v1/users: 自テナントのユーザー一覧 (view) と招待 (admin ロール限定)
import { readJsonBody } from '@/lib/api/body';
import { requireAction, requireAdminRole } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { parsePageQuery } from '@/lib/api/pagination';
import { toListDto, toUserDto } from '@/lib/api/serializers';
import type { ApiSchemas } from '@/lib/api-types';
import { userCreateSchema } from '@/lib/validations/user';

// 認証に依存するので静的化しない
export const dynamic = 'force-dynamic';

// GET /users (listUsers)
export const GET = route(async ({ request, principal, repos }) => {
  // view 権限
  const { tenantId } = requireAction(principal, 'view');
  // 自テナントで絞って一覧する
  const page = await repos.users.list(tenantId, parsePageQuery(new URL(request.url)));
  // DTO へ写す
  const body: ApiSchemas['UserList'] = toListDto(page, toUserDto);
  return Response.json(body);
});

// POST /users (createUser): 招待。admin ロール限定 (UC-02)
export const POST = route(async ({ request, principal, repos }) => {
  // admin ロールであること
  const { tenantId } = requireAdminRole(principal);
  // 本文を検証する
  const input = await readJsonBody(request, userCreateSchema);
  // 自テナントに作る (メール重複は DuplicateError → 422)。tenantId は入力の後ろに置き、
  // 検証済みの入力に何が含まれていてもテナントを上書きできない形にする
  const user = await repos.users.create({ ...input, tenantId });
  // 201 で返す
  return Response.json(toUserDto(user), { status: HTTP_STATUS.CREATED });
});
