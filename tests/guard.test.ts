// 認可ガード (src/lib/api/guard.ts) が許可表を実際に引いていることを固定する。
//
// **なぜ RBAC 行列テストだけでは足りないか**: 現在の許可表ではどの役割も `view` を持つため、
// `view` の分岐を無条件許可へ書き換えても API 経路のテストは差を観測できない
// (実測で `if (action !== 'view' && !canPerform(...))` へ変えると全件緑になった)。
// 未知の役割を渡す経路なら「許可表を引いているか」を役割の中身に依存せず確かめられる
import { describe, expect, it } from 'vitest';
import { requireAction, requireAdminRole, requireTenantUser } from '@/lib/api/guard';
import { ACTIONS } from '@/domain/rbac';
import type { Principal } from '@/lib/api/auth';
import { ApiError } from '@/lib/api/errors';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { Role } from '@/domain/types';

// 役割を差し替えられるテナントユーザーの主体を作る (許可表に無い役割も渡せるよう string で受ける)
function userPrincipal(role: string): Principal {
  // 認証済みのテナントユーザー (id 類は判定に使われない)
  return {
    kind: 'user',
    tenantId: 'tenant-1',
    user: {
      id: 'user-1',
      tenantId: 'tenant-1',
      email: 'user@example.com',
      name: '利用者',
      // 許可表に無い値も試すため型を外して入れる (本番では DB の enum 列から来る)
      role: role as Role,
      disabledAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  } as Principal;
}

describe('requireAction', () => {
  // 許可表にある全操作を対象にする (操作の一覧は許可表から導く。写しを持たない)
  it.each([...ACTIONS])('許可表に無い役割は %s でも拒否する (fail-closed)', (action) => {
    // DB へ未知の役割の行が入った / enum を増やして許可表の更新を忘れた場合を模す
    expect(() => requireAction(userPrincipal('superuser'), action)).toThrow(ApiError);
  });

  it('許可表にある役割は許可された操作を通す (検証が広すぎないこと)', () => {
    // viewer は view を持つ
    expect(requireAction(userPrincipal(Role.viewer), 'view').user.role).toBe(Role.viewer);
  });

  it('プラットフォーム管理者はテナント内の操作を行えない (403)', () => {
    // テナント境界の外側の主体
    const principal = { kind: 'platform' } as Principal;
    // 403 で拒否される
    try {
      requireAction(principal, 'view');
      // ここへ来たら拒否されていない
      expect.unreachable('プラットフォーム管理者が view を通ってしまった');
    } catch (error) {
      // ステータスまで確かめる (404 や 500 に化けていないこと)
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(HTTP_STATUS.FORBIDDEN);
    }
  });
});

describe('requireAdminRole / requireTenantUser', () => {
  it('admin 以外の役割は拒否する', () => {
    // operator は admin 限定の操作を行えない
    expect(() => requireAdminRole(userPrincipal(Role.operator))).toThrow(ApiError);
  });

  it('admin は通す', () => {
    // 役割そのものを比べる唯一の用途 (docs/spec.md §4)
    expect(requireAdminRole(userPrincipal(Role.admin)).user.role).toBe(Role.admin);
  });

  it('プラットフォーム管理者はテナントユーザーとして扱わない', () => {
    // テナント内の資源に触れる主体ではない
    expect(() => requireTenantUser({ kind: 'platform' } as Principal)).toThrow(ApiError);
  });
});
