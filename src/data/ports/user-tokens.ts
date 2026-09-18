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

// 発行の結果。'not_found' は発行先が同テナントに居ない、'disabled' は発行先が無効化済み。
// 判定と挿入はアダプタが 1 つの原子的な操作として行う (API 層で findById → create と分けると、並行する無効化と
// すれ違って「無効化済みユーザーのトークン」が作られる。認証で必ず 401 になる使えない資格情報を作らない)
export type UserTokenCreateResult =
  { status: 'ok'; token: UserTokenRecord } | { status: 'not_found' } | { status: 'disabled' };

// ハッシュ照合の結果 (トークンと発行先ユーザー)
export interface UserTokenLookup {
  token: UserTokenRecord;
  user: UserRecord;
}

// ユーザートークン Port
export interface UserTokensPort {
  // トークンを発行する (発行先が同テナントに無ければ 'not_found'、無効化済みなら 'disabled'。原子的)
  create(input: CreateUserTokenInput): Promise<UserTokenCreateResult>;
  // ハッシュでトークンを引く (認証時。失効・期限は呼び出し側が判定する)
  findByHash(tokenHash: string): Promise<UserTokenLookup | null>;
  // あるユーザーのトークンを一覧する
  list(tenantId: string, userId: string, query: PageQuery): Promise<Page<UserTokenRecord>>;
  // トークンを失効させる (見つからなければ null。既に失効済みなら日時はそのまま)
  revoke(tenantId: string, userId: string, id: string): Promise<UserTokenRecord | null>;
}
