// エージェント操作の Port (契約)。すべてテナントで絞る
import type { AgentStatus, Provider } from '@/domain/types';
import type { AgentRecord, Page, PageQuery } from './types';

// 一覧の絞り込み条件
export interface AgentFilter {
  // 稼働状態で絞る (省略時は全件)
  status?: AgentStatus;
}

// エージェント作成の入力
export interface CreateAgentInput {
  tenantId: string;
  name: string;
  description: string | null;
  provider: Provider;
  model: string;
  budgetMicroUsd: bigint | null;
}

// エージェント更新の入力 (undefined のプロパティは変更しない。null は未設定へ戻す)
export interface UpdateAgentInput {
  name?: string;
  description?: string | null;
  model?: string;
  budgetMicroUsd?: bigint | null;
}

// 削除の結果。履歴 (UsageEvent / EvaluationRun / Incident) を持つエージェントは削除できない (docs/spec.md §3)
export type DeleteAgentResult = 'deleted' | 'not_found' | 'restricted';

// エージェント Port
export interface AgentsPort {
  // テナント内のエージェントを一覧する
  list(tenantId: string, query: PageQuery, filter?: AgentFilter): Promise<Page<AgentRecord>>;
  // テナント内のエージェントを id で引く (他テナントの id は null)
  findById(tenantId: string, id: string): Promise<AgentRecord | null>;
  // エージェントを作る (テナント内で名前が重複していれば DuplicateError('name'))
  create(input: CreateAgentInput): Promise<AgentRecord>;
  // エージェントを更新する (見つからなければ null。名前重複は DuplicateError('name'))
  update(tenantId: string, id: string, patch: UpdateAgentInput): Promise<AgentRecord | null>;
  // 稼働状態を変える (見つからなければ null)
  setStatus(tenantId: string, id: string, status: AgentStatus): Promise<AgentRecord | null>;
  // エージェントを削除する (履歴があれば 'restricted')
  delete(tenantId: string, id: string): Promise<DeleteAgentResult>;
}
