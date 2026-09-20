// API キー操作の Port (契約)。**認証の入口 (findByHash) 以外は**すべてテナントで絞る
import type { AgentRecord, ApiKeyRecord, Page, PageQuery } from './types';

// API キー発行の入力 (平文は渡さない)
export interface CreateApiKeyInput {
  tenantId: string;
  // 紐づけるエージェント (テナント共通キーなら null)。同テナントに無ければ発行しない
  agentId: string | null;
  prefix: string;
  keyHash: string;
  name: string;
}

// ハッシュ照合の結果 (キーと、紐づくエージェント)。
// エージェントは「テナント共通キー (agentId = null)」のとき null になる
export interface ApiKeyLookup {
  key: ApiKeyRecord;
  agent: AgentRecord | null;
}

// API キー Port
export interface ApiKeysPort {
  // テナント内の API キーを一覧する (失効済みも含む)
  list(tenantId: string, query: PageQuery): Promise<Page<ApiKeyRecord>>;
  // テナント内の API キーを id で引く (他テナントの id は null)
  findById(tenantId: string, id: string): Promise<ApiKeyRecord | null>;
  // API キーを発行する (agentId が同テナントに無ければ null)
  create(input: CreateApiKeyInput): Promise<ApiKeyRecord | null>;
  // ハッシュで API キーを引く (プロキシの認証時)。**この 1 つだけテナントを跨いで検索する** —
  // 提示された資格情報からテナントを決める経路なので、絞り込む材料がまだ無い。失効・エージェントの状態は
  // 呼び出し側が判定する (どの理由でも同じ応答を返すため、ここでは選り分けない)
  findByHash(keyHash: string): Promise<ApiKeyLookup | null>;
  // API キーを失効させる (見つからなければ null。既に失効済みなら日時はそのまま)
  revoke(tenantId: string, id: string): Promise<ApiKeyRecord | null>;
}
