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

// エージェント数の上限 (プラン別。正本は src/domain/plan.ts)。
// **省略可にしない** — 既定値を持たせると、新しい呼び出し側が渡し忘れたぶんだけ上限が静かに消える
// (Step4 の `GuardrailRuleLimits` で同じ判断をしている)
export interface AgentLimits {
  // 1 テナントが登録できるエージェントの数
  maxAgents: number;
}

/**
 * 作成の結果。
 *
 * **上限超過を例外にせず戻り値で表す** — 名前の重複 (`DuplicateError`) は「入力が不正」だが、
 * 上限は「入力は正しいが今は作れない」なので HTTP では 409 に写る (重複は 422)。
 * 判定はアダプタが挿入と同じ原子的操作の中で行う (API 層で数えると同時の 2 件が上限を超える)。
 */
export type CreateAgentResult =
  { status: 'created'; agent: AgentRecord } | { status: 'too_many_agents' };

// エージェント Port
export interface AgentsPort {
  // テナント内のエージェントを一覧する
  list(tenantId: string, query: PageQuery, filter?: AgentFilter): Promise<Page<AgentRecord>>;
  // テナント内のエージェントを id で引く (他テナントの id は null)
  findById(tenantId: string, id: string): Promise<AgentRecord | null>;
  // 指定した id のエージェント名を id → 名前 の表で引く (画面の一覧が名前を出すのに使う)。
  // **一覧の先頭から N 件取って突き合わせる形にしない** — 並びは createdAt 昇順なので、
  // 上限より多くのエージェントを持つテナントでは**新しいエージェントだけ**名前が出ず id のまま
  // 残る (しかもインシデントも古い順なので、後ろのページほど取りこぼしが集まる)。
  // 他テナントの id を混ぜても結果に現れない (テナントで絞るのは実装の責務)
  findNamesByIds(tenantId: string, ids: readonly string[]): Promise<Map<string, string>>;
  // エージェントを作る (テナント内で名前が重複していれば DuplicateError('name')、
  // プランの上限に達していれば 'too_many_agents')
  create(input: CreateAgentInput, limits: AgentLimits): Promise<CreateAgentResult>;
  // エージェントを更新する (見つからなければ null。名前重複は DuplicateError('name'))
  update(tenantId: string, id: string, patch: UpdateAgentInput): Promise<AgentRecord | null>;
  // 稼働状態を変える (見つからなければ null)
  setStatus(tenantId: string, id: string, status: AgentStatus): Promise<AgentRecord | null>;
  // エージェントを削除する (履歴があれば 'restricted')
  delete(tenantId: string, id: string): Promise<DeleteAgentResult>;
}
