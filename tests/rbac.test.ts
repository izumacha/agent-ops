// Vitest のテスト API
import { describe, expect, it } from 'vitest';
// 検証対象: 役割 × 操作の許可表と判定関数
import { ACTIONS, PERMISSIONS, canPerform } from '@/domain/rbac';
// 役割の一覧 (正準な参照元)
import { Role } from '@/domain/types';

// 期待する許可表 (役割 3 × 操作 3 = 9 パターンを 1 つずつ固定する)
const EXPECTED: Record<Role, Record<(typeof ACTIONS)[number], boolean>> = {
  viewer: { view: true, execute: false, stop: false },
  operator: { view: true, execute: true, stop: false },
  admin: { view: true, execute: true, stop: true },
};

describe('RBAC の許可表', () => {
  // 役割ごとに 3 操作すべての判定を固定する
  for (const role of Object.values(Role)) {
    // その役割について 3 操作を順に見る
    for (const action of ACTIONS) {
      // 1 パターン = 1 テストにして、どの組み合わせが崩れたか名前で分かるようにする
      it(`${role} が ${action} を ${EXPECTED[role][action] ? '行える' : '行えない'}`, () => {
        // 判定関数の結果が期待値と一致すること
        expect(canPerform(role, action)).toBe(EXPECTED[role][action]);
      });
    }
  }

  it('許可表は Prisma の Role をすべて網羅している (役割を足したら表も更新する)', () => {
    // 表のキー集合と enum の値集合が一致すること
    expect(Object.keys(PERMISSIONS).sort()).toEqual(Object.values(Role).sort());
  });

  it('未知の役割・操作は拒否する (fail-closed)', () => {
    // 型を迂回して未知の値を渡しても false になること
    expect(canPerform('root' as Role, 'view')).toBe(false);
    expect(canPerform(Role.admin, 'delete' as (typeof ACTIONS)[number])).toBe(false);
  });
});
