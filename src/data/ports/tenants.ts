// テナント操作の Port (契約)。実装は adapters/memory と adapters/prisma
import type { Page, PageQuery, TenantRecord, UserRecord, UserTokenRecord } from './types';

// テナント作成の入力。最初の admin ユーザーとそのログイントークンを同時に作る (UC-01)。
// 3 つの書き込みを 1 つの操作にするのは、途中で失敗して「admin のいないテナント」が残らないようにするため
export interface CreateTenantInput {
  // テナントの表示名
  name: string;
  // 最初の admin ユーザー
  admin: {
    email: string;
    name: string;
  };
  // admin に発行するログイントークン (平文は呼び出し側が生成し、ここにはハッシュだけ渡す)
  token: {
    prefix: string;
    tokenHash: string;
    name: string;
    expiresAt: Date;
  };
}

// テナント作成の出力 (作った 3 行)
export interface CreateTenantResult {
  tenant: TenantRecord;
  admin: UserRecord;
  token: UserTokenRecord;
}

// テナント Port
export interface TenantsPort {
  // 全テナントを一覧する (プラットフォーム管理者専用。テナント境界の外側なので tenantId を取らない)
  list(query: PageQuery): Promise<Page<TenantRecord>>;
  // id でテナントを引く (無ければ null)
  findById(id: string): Promise<TenantRecord | null>;
  // テナント + 最初の admin + そのトークンを原子的に作る。admin の役割は必ず admin にする
  createWithAdmin(input: CreateTenantInput): Promise<CreateTenantResult>;
}
