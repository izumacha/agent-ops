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

// ユーザー Port
export interface UsersPort {
  // テナント内のユーザーを一覧する
  list(tenantId: string, query: PageQuery): Promise<Page<UserRecord>>;
  // テナント内のユーザーを id で引く (他テナントの id は null)
  findById(tenantId: string, id: string): Promise<UserRecord | null>;
  // ユーザーを作る (テナント内でメールが重複していれば DuplicateError('email'))
  create(input: CreateUserInput): Promise<UserRecord>;
  // 役割を変える (見つからなければ null)
  updateRole(tenantId: string, id: string, role: Role): Promise<UserRecord | null>;
  // ユーザーを無効化する (見つからなければ null。既に無効なら日時はそのまま)
  disable(tenantId: string, id: string): Promise<UserRecord | null>;
  // 有効な admin の人数 (最後の admin を降格・無効化しないための判定に使う)
  countActiveAdmins(tenantId: string): Promise<number>;
}
