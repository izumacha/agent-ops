// ガードレールのルールとインシデントの Port (契約)。読み書きは必ずテナントで絞る (ADR-0002)。
// **ルールの発火から停止までを 1 つの原子的な操作にする**のが Step4 の要点 (受け入れ基準「発火から
// 停止まで ≦ 3 秒」)。インシデントの記録とエージェントの停止が別々のトランザクションだと、
// 片方だけが成立した状態 (止まったが記録が無い / 記録はあるが止まっていない) を作れてしまう。
import type { IncidentStatus, RuleAction, RuleKind } from '@/domain/types';
import type { GuardrailRuleRecord, IncidentRecord, Page, PageQuery } from './types';

// ルールの作成入力
export interface CreateGuardrailRuleInput {
  tenantId: string;
  // 対象エージェント (null ならテナント全体)
  agentId: string | null;
  kind: RuleKind;
  threshold: number;
  windowMinutes: number;
  action: RuleAction;
}

// ルールの作成結果。**同じ種別のルールを複数持てる**ことにした —
// 「50% で通知、80% で停止」のような段階的な設定が自然で、禁じる理由が無い。
// 代わりにテナントあたりの件数に上限を置く (判定は中継 1 回ごとに走るので、
// ルールが増えるほど毎回の集計が増える。§8 / §9)。上限の判定は**作成と同じ原子的な操作**で行う —
// 件数を数えてから挿入する形に分けると、同時に 2 件来たときに上限を超えられる
export type CreateGuardrailRuleResult =
  | { status: 'created'; rule: GuardrailRuleRecord }
  // 対象エージェントが同テナントに無い (他テナントの id を指した場合も含む)
  | { status: 'agent_not_found' }
  // テナントのルール数が上限に達している
  | { status: 'too_many_rules' };

// ルールの削除結果 (インシデントを持つルールは消せない = Restrict)
export type DeleteGuardrailRuleResult = 'deleted' | 'not_found' | 'restricted';

// 評価の対象になるルールの絞り込み。**エージェント指定のルールとテナント全体のルールの両方を返す** —
// 「このエージェントの呼び出しで評価すべきルール」は agentId が一致するものと null のものの和集合
export interface ActiveRuleQuery {
  // 判定のきっかけになったエージェント
  agentId: string;
  // 種別で絞る (指定が無ければ全種別)。評価の起点によって見る種別が違うため
  // (プロキシの中継後はコストとエラー率、評価実行の後は品質)
  kinds?: readonly RuleKind[];
}

// 発火の記録と停止をまとめて行う入力
export interface RaiseIncidentInput {
  tenantId: string;
  agentId: string;
  ruleId: string;
  // 発火理由の要約 (機微情報を入れない)
  summary: string;
  // エージェントを停止するか (ルールの action が stop のとき true)
  suspendAgent: boolean;
}

// 発火の結果。**停止したかどうかも返す** — 呼び出し側 (通知と監査ログ) が
// 「実際に何が起きたか」を記録するため。エージェントかルールが同テナントに無ければ null
export interface RaisedIncident {
  incident: IncidentRecord;
  // 停止を要求し、かつ実際に状態が変わったか (既に stopped / suspended なら false)
  suspended: boolean;
}

// インシデントの解決結果
export type ResolveIncidentResult = 'resolved' | 'not_found' | 'already_resolved';

// インシデント一覧の絞り込み
export interface IncidentFilter {
  agentId?: string;
  status?: IncidentStatus;
}

// ガードレールのルール Port
export interface GuardrailRulesPort {
  // ルールを作る (上限に達していれば 'too_many_rules'、対象エージェントが無ければ 'agent_not_found')
  create(
    input: CreateGuardrailRuleInput,
    maxRulesPerTenant: number,
  ): Promise<CreateGuardrailRuleResult>;
  // ルールを一覧する (テナント内、createdAt 昇順)
  list(tenantId: string, query: PageQuery): Promise<Page<GuardrailRuleRecord>>;
  // ルールを消す (インシデントを持つルールは 'restricted'。無効化は enabled を false にする)
  delete(tenantId: string, ruleId: string): Promise<DeleteGuardrailRuleResult>;
  // **判定の対象になる有効なルールを引く** (エージェント指定のものとテナント全体のものの和集合)。
  // ページ送りを持たないのは、これが中継 1 回ごとに走る経路で、
  // 「有効なルールは少数」という前提に立っているため (上限は API 側のルール数制限で担保する)
  findActiveRules(tenantId: string, query: ActiveRuleQuery): Promise<GuardrailRuleRecord[]>;
}

// インシデント Port
export interface IncidentsPort {
  // **発火を記録し、必要なら同じトランザクションでエージェントを停止する。**
  // 1 つの操作にするのは、片方だけ成立した状態 (止まったが記録が無い等) を作らないため
  raise(input: RaiseIncidentInput): Promise<RaisedIncident | null>;
  // インシデントを一覧する (テナント内、triggeredAt 昇順。絞り込みは任意)
  list(tenantId: string, query: PageQuery, filter?: IncidentFilter): Promise<Page<IncidentRecord>>;
  // インシデントを引く (他テナントのものは null)
  findById(tenantId: string, incidentId: string): Promise<IncidentRecord | null>;
  // インシデントを解決済みにする (冪等ではなく、既に解決済みなら 'already_resolved' を返す —
  // 「解決した」操作を監査ログに何度も残さないため)
  resolve(tenantId: string, incidentId: string): Promise<ResolveIncidentResult>;
}
