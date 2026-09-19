// API キー操作の Port (契約)。すべてテナントで絞る
import type { ApiKeyRecord, Page, PageQuery } from './types';

// API キー発行の入力 (平文は渡さない)
export interface CreateApiKeyInput {
  tenantId: string;
  // 紐づけるエージェント (テナント共通キーなら null)。同テナントに無ければ発行しない
  agentId: string | null;
  prefix: string;
  keyHash: string;
  name: string;
}

// API キー Port
export interface ApiKeysPort {
  // テナント内の API キーを一覧する (失効済みも含む)
  list(tenantId: string, query: PageQuery): Promise<Page<ApiKeyRecord>>;
  // テナント内の API キーを id で引く (他テナントの id は null)
  findById(tenantId: string, id: string): Promise<ApiKeyRecord | null>;
  // API キーを発行する (agentId が同テナントに無ければ null)
  create(input: CreateApiKeyInput): Promise<ApiKeyRecord | null>;
  // API キーを失効させる (見つからなければ null。既に失効済みなら日時はそのまま)
  revoke(tenantId: string, id: string): Promise<ApiKeyRecord | null>;
}
