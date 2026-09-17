// ユーザー操作の Port (契約)。すべてテナントで絞る (ADR-0002)
import type { Role } from '@/domain/types';
import type { Page, PageQuery, UserRecord } from './types';

// ユーザー作成の入力
export interface CreateUserInput {
  tenantId: string;
  email: string;
  name: string;
  role: Role;
}

// 役割変更・無効化の結果。'last_admin' は「最後の有効な admin を降格・無効化しようとした」拒否で、
// 判定と更新はアダプタが 1 つの原子的な操作として行う (API 層で count → update と分けると並行要求で admin が 0 人になる)
export type UserMutationResult =
  { status: 'ok'; user: UserRecord } | { status: 'not_found' } | { status: 'last_admin' };

// ユーザー Port
export interface UsersPort {
  // テナント内のユーザーを一覧する
  list(tenantId: string, query: PageQuery): Promise<Page<UserRecord>>;
  // テナント内のユーザーを id で引く (他テナントの id は null)
  findById(tenantId: string, id: string): Promise<UserRecord | null>;
  // テナント内のユーザーをメールで引く (テナント内で一意。無ければ null)
  findByEmail(tenantId: string, email: string): Promise<UserRecord | null>;
  // ユーザーを作る (テナント内でメールが重複していれば DuplicateError('email'))
  create(input: CreateUserInput): Promise<UserRecord>;
  // 役割を変える。最後の有効な admin を admin 以外へ変える要求は 'last_admin' で拒否する (原子的)
  updateRole(tenantId: string, id: string, role: Role): Promise<UserMutationResult>;
  // ユーザーを無効化する (既に無効なら日時はそのまま)。最後の有効な admin は 'last_admin' で拒否する (原子的)
  disable(tenantId: string, id: string): Promise<UserMutationResult>;
}
