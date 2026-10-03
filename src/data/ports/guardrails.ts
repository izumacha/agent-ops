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
// 件数を数えてから挿入する形に分けると、同時に 2 件来たときに上限を超えられる。
// **数えるのは有効なルールだけ** (`enabled` が true) — 無効化したものまで数えると、発火済みで
// 削除できないルールがたまったテナントが**二度とルールを作れなくなる** (無効化が唯一の
// 後始末なのに、その結果が上限を食い続ける)。判定の費用も有効なルールにしか掛からない
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
  // 新しく作った行、または**既に開いていた同じルールの行**
  incident: IncidentRecord;
  // 停止を要求し、かつ実際に状態が変わったか (既に stopped / suspended なら false)
  suspended: boolean;
  /**
   * 新しい行を作ったか。**開いているインシデントが既にあれば作らない (false)。**
   *
   * 重複を排除しないと、超過が続くあいだ判定のたびに行が増える。`action` が notify の
   * ルールは停止しないので条件が自己収束せず、実測では 1 本のルールで中継のたびに
   * インシデント・監査ログ・通知 2 通が増え続けた (レート制限の上限まで毎分 600 件)。
   *
   * **停止は重複排除の対象にしない** — 既に開いているインシデントがあっても、その間に
   * 復帰させられたエージェントは再び止める必要がある (止めないと「超過しているのに動いている」
   * 状態が残る)。だから `suspended` は `created` と独立に真になりうる。
   */
  created: boolean;
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
  // ルールを消す (インシデントを持つルールは 'restricted'。無効化は下の setEnabled)
  delete(tenantId: string, ruleId: string): Promise<DeleteGuardrailRuleResult>;
  /**
   * ルールの有効・無効を切り替える (他テナントの id は null)。
   *
   * **発火記録を持つルールは削除できないので、設定を誤ったルールを止める唯一の手段。**
   * これが無かったあいだ、しきい値を誤った `stop` のルールはインシデントを解決して
   * エージェントを復帰させても次の中継で再び発火し、回復には DB の直接操作が必要だった。
   *
   * **切り替えられるのは `enabled` だけ。** しきい値・種別・集計窓を変えられるようにすると、
   * 過去のインシデントが「どの条件で発火したか」を指さなくなる (条件を変えるときは
   * 無効にして新しいルールを作る)。
   *
   * **冪等**（既に同じ値でも成功して現在の行を返す）— 2 度押しや再試行で 409 にしない。
   */
  setEnabled(
    tenantId: string,
    ruleId: string,
    enabled: boolean,
  ): Promise<GuardrailRuleRecord | null>;
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
  // インシデントを一覧する (テナント内、createdAt 昇順。絞り込みは任意)
  list(tenantId: string, query: PageQuery, filter?: IncidentFilter): Promise<Page<IncidentRecord>>;
  // インシデントを引く (他テナントのものは null)
  findById(tenantId: string, incidentId: string): Promise<IncidentRecord | null>;
  // インシデントを解決済みにする (冪等ではなく、既に解決済みなら 'already_resolved' を返す —
  // 「解決した」操作を監査ログに何度も残さないため)
  resolve(tenantId: string, incidentId: string): Promise<ResolveIncidentResult>;
}
