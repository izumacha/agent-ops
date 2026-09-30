// 全 Port をまとめた束 (Composition Root と API 層が受け渡す単位)
import type { AgentsPort } from './agents';
import type { ApiKeysPort } from './api-keys';
import type { EvaluationsPort } from './evaluations';
import type { TenantsPort } from './tenants';
import type { UserTokensPort } from './user-tokens';
import type { UsageEventsPort } from './usage-events';
import type { UsersPort } from './users';

// リポジトリの束
export interface Repositories {
  tenants: TenantsPort;
  users: UsersPort;
  userTokens: UserTokensPort;
  agents: AgentsPort;
  apiKeys: ApiKeysPort;
  usageEvents: UsageEventsPort;
  evaluations: EvaluationsPort;
}

// 各 Port の型と入力型をここから再公開する (利用側は個別ファイルのパスを知らなくてよい)
export type * from './agents';
export type * from './api-keys';
export type * from './evaluations';
export type * from './tenants';
export type * from './types';
export type * from './usage-events';
export type * from './user-tokens';
export type * from './users';
