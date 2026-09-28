// 認可ガード: 認証済みの主体 (Principal) に対して、操作ごとの権限を確かめる。
// 権限の語彙は 3 種類 (docs/spec.md §4): RBAC の 3 操作 / admin ロール限定 / プラットフォーム管理者
import { canPerform, type Action } from '@/domain/rbac';
import { Role } from '@/domain/types';
import { API_MESSAGES } from '@/lib/constants';
import type { AgentPrincipal, Principal, UserPrincipal } from './auth';
import { ApiError } from './errors';
import { HTTP_STATUS } from './http-status';

// テナントのユーザーであることを要求する (プラットフォーム管理者はテナント内の資源に触れない)
export function requireTenantUser(principal: Principal): UserPrincipal {
  // プラットフォーム管理者ならテナント境界の外側なので拒否する
  if (principal.kind !== 'user') {
    throw new ApiError(HTTP_STATUS.FORBIDDEN, API_MESSAGES.tenantScopeRequired);
  }
  // テナントのユーザー
  return principal;
}

// RBAC の操作 (view / execute / stop) を要求する。許可表 src/domain/rbac.ts が唯一の真実の源
export function requireAction(principal: Principal, action: Action): UserPrincipal {
  // まずテナントのユーザーであること
  const user = requireTenantUser(principal);
  // 許可表で判定する (未知の役割は canPerform が拒否する = fail-closed)
  if (!canPerform(user.user.role, action)) {
    throw new ApiError(HTTP_STATUS.FORBIDDEN, API_MESSAGES.forbidden);
  }
  // 許可された
  return user;
}

// admin ロール限定の操作 (ユーザー招待・役割変更・トークン発行) を要求する。
// 3 操作の表とは別軸なので、ここだけは役割そのものを比べる (docs/spec.md §4 の「唯一の用途」)
export function requireAdminRole(principal: Principal): UserPrincipal {
  // まずテナントのユーザーであること
  const user = requireTenantUser(principal);
  // 役割が admin であること
  if (user.user.role !== Role.admin)
    throw new ApiError(HTTP_STATUS.FORBIDDEN, API_MESSAGES.forbidden);
  // 許可された
  return user;
}

// プロキシ経路: API キーで認証されたエージェントであることを要求する。
// route() に auth: 'apiKey' を指定していれば必ず満たされるが、指定を落としたときに
// 「ユーザートークンで中継できる」状態へ静かに変わらないよう、本体側でも確かめる (fail-closed)
export function requireProxyAgent(principal: Principal): AgentPrincipal {
  // エージェント以外 (ユーザー・プラットフォーム管理者) はこの経路を使えない
  if (principal.kind !== 'agent') {
    throw new ApiError(HTTP_STATUS.FORBIDDEN, API_MESSAGES.apiKeyRequired);
  }
  // エージェント主体
  return principal;
}

// プラットフォーム管理者であることを要求する (テナント作成・列挙)
export function requirePlatformAdmin(principal: Principal): void {
  // テナントのユーザーは、たとえ admin でも他テナントを作れない
  if (principal.kind !== 'platform') {
    throw new ApiError(HTTP_STATUS.FORBIDDEN, API_MESSAGES.platformAdminRequired);
  }
}
