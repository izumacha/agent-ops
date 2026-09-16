// 役割 (Role) の正準な参照元
import { Role } from '@/domain/types';

/**
 * RBAC で扱う操作の種類。
 * Step1 の受け入れ基準「役割 3 × 操作 3 の全パターンで権限違反が 403」の「操作 3」がこれ。
 */
export const ACTIONS = ['view', 'execute', 'stop'] as const;
// 操作の型 (上の配列の要素型)
export type Action = (typeof ACTIONS)[number];

/**
 * 役割ごとに許可する操作の表。**この表が唯一の真実の源**で、API 層・UI 層はここを参照する。
 * - viewer: 閲覧のみ
 * - operator: 閲覧 + 実行
 * - admin: 閲覧 + 実行 + 停止
 * 「不明なら拒否」(fail-closed) を保つため、表に無い組み合わせはすべて拒否になる。
 */
export const PERMISSIONS: Readonly<Record<Role, ReadonlySet<Action>>> = {
  // 閲覧者: 見るだけ
  [Role.viewer]: new Set<Action>(['view']),
  // 運用者: 見る + 実行する
  [Role.operator]: new Set<Action>(['view', 'execute']),
  // 管理者: 見る + 実行する + 止める
  [Role.admin]: new Set<Action>(['view', 'execute', 'stop']),
};

/**
 * 役割 role が操作 action を行えるかを判定する純粋関数。
 * DB・フレームワークに依存しないので、ユニットテストで全パターンを固定できる。
 */
export function canPerform(role: Role, action: Action): boolean {
  // 表からその役割の許可集合を引く (未知の役割なら undefined)
  const allowed = PERMISSIONS[role];
  // 許可集合に含まれていれば true、無ければ (未知の役割も含めて) false
  return allowed?.has(action) ?? false;
}
