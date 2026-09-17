// ユーザーのログイントークン操作の Port (契約)
import type { Page, PageQuery, UserRecord, UserTokenRecord } from './types';

// トークン発行の入力 (平文は渡さない。ハッシュと表示用の先頭だけ)
export interface CreateUserTokenInput {
  tenantId: string;
  userId: string;
  prefix: string;
  tokenHash: string;
  name: string;
  expiresAt: Date;
}

// ハッシュ照合の結果 (トークンと発行先ユーザー)
export interface UserTokenLookup {
  token: UserTokenRecord;
  user: UserRecord;
}

// ユーザートークン Port
export interface UserTokensPort {
  // トークンを発行する (発行先ユーザーが同テナントに無ければ null)
  create(input: CreateUserTokenInput): Promise<UserTokenRecord | null>;
  // ハッシュでトークンを引く (認証時。失効・期限は呼び出し側が判定する)
  findByHash(tokenHash: string): Promise<UserTokenLookup | null>;
  // あるユーザーのトークンを一覧する
  list(tenantId: string, userId: string, query: PageQuery): Promise<Page<UserTokenRecord>>;
  // トークンを失効させる (見つからなければ null。既に失効済みなら日時はそのまま)
  revoke(tenantId: string, userId: string, id: string): Promise<UserTokenRecord | null>;
}
