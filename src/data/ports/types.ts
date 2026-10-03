// データ層の Port が扱うレコード型とページネーション型 (Prisma / Next 非依存)。
// API 層と memory / prisma アダプタが共通で使う。Prisma の生成型を使わないのは、
// memory アダプタと API テストが `npm run db:generate` 無しでも動くようにするため
import type {
  AgentStatus,
  EvaluationExclusionReason,
  EvaluationRunStatus,
  IncidentStatus,
  Plan,
  Provider,
  Role,
  RuleAction,
  RuleKind,
} from '@/domain/types';

// カーソルが指す位置 (createdAt, id)。符号化・復号の規則は src/data/page.ts
export interface CursorKey {
  createdAt: Date;
  id: string;
}

// 一覧取得の入力 (件数と続きの位置)
export interface PageQuery {
  // 取得件数 (呼び出し側で 1〜最大値に正規化済み)
  limit: number;
  // 前回応答の nextCursor を API 層で復号した位置 (無ければ先頭から)。復号は API 層で 1 回だけ行う
  cursor?: CursorKey;
}

// 一覧取得の出力 (次ページがあるときだけ nextCursor を持つ)
export interface Page<T> {
  // 取得した行
  items: T[];
  // 次ページの先頭を指すカーソル (最終行の位置 (createdAt, id) を符号化した不透明な値。src/data/page.ts。次ページが無ければ undefined)
  nextCursor?: string;
}

// テナント
export interface TenantRecord {
  id: string;
  name: string;
  plan: Plan;
  createdAt: Date;
  updatedAt: Date;
}

// ユーザー
export interface UserRecord {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: Role;
  // 無効化日時 (null なら有効)
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ユーザーのログイントークン (ハッシュのみ。平文は持たない)
export interface UserTokenRecord {
  id: string;
  tenantId: string;
  userId: string;
  prefix: string;
  tokenHash: string;
  name: string;
  createdAt: Date;
  expiresAt: Date;
  // 失効日時 (null なら有効)
  revokedAt: Date | null;
}

// エージェント
export interface AgentRecord {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  provider: Provider;
  model: string;
  status: AgentStatus;
  // 月次予算 (マイクロ USD)。未設定は null
  budgetMicroUsd: bigint | null;
  createdAt: Date;
  updatedAt: Date;
}

// API キー (ハッシュのみ。平文は持たない)
export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  // 紐づくエージェント (テナント共通キーなら null)
  agentId: string | null;
  prefix: string;
  keyHash: string;
  name: string;
  createdAt: Date;
  // 失効日時 (null なら有効)
  revokedAt: Date | null;
}

// 利用イベント (プロキシが中継した LLM 呼び出し 1 回)
export interface UsageEventRecord {
  id: string;
  tenantId: string;
  agentId: string;
  provider: Provider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  // 料金 (マイクロ USD)
  costMicroUsd: bigint;
  // 上流の応答までにかかった時間 (ミリ秒)
  latencyMs: number;
  // 上流の HTTP ステータス
  statusCode: number;
  createdAt: Date;
}

// 評価セット (LLM-as-judge の固定入力集合)
export interface EvaluationSetRecord {
  id: string;
  tenantId: string;
  name: string;
  createdAt: Date;
}

// 評価ケース (入力と期待出力の 1 組)。**tenantId を持たない** —
// 親の EvaluationSet 経由でしか到達しない子テーブルなので、テナントの絞り込みは親で行う
// (docs/spec.md §3。setId だけで直接引かない)
export interface EvaluationCaseRecord {
  id: string;
  setId: string;
  // セット内の並び順 (0 始まり)
  position: number;
  input: string;
  // 期待する出力 (無ければ null)
  expected: string | null;
}

// 評価実行 (評価セット × エージェントの採点結果)
export interface EvaluationRunRecord {
  id: string;
  tenantId: string;
  agentId: string;
  setId: string;
  // 採点できたケースの平均 (1 件も採点できなければ null)
  accuracy: number | null;
  safety: number | null;
  deviation: number | null;
  // 採点として使えるか
  status: EvaluationRunStatus;
  // 採点できた件数 / 除外した件数
  scoredCases: number;
  excludedCases: number;
  // どの judge が採点したか (別の judge の実行どうしを比べても意味が無いので残す)
  judgeProvider: Provider;
  judgeModel: string;
  createdAt: Date;
}

// 採点結果 (実行 × ケース)。スコア 3 つか除外理由のどちらかを持つ (DB の CHECK 制約と同じ規律)
export interface EvaluationResultRecord {
  id: string;
  tenantId: string;
  runId: string;
  setId: string;
  caseId: string;
  accuracy: number | null;
  safety: number | null;
  deviation: number | null;
  excludedReason: EvaluationExclusionReason | null;
}

// ガードレールのルール (しきい値と発火時の動作。Step4)
export interface GuardrailRuleRecord {
  id: string;
  tenantId: string;
  // 対象エージェント (null ならテナント全体)
  agentId: string | null;
  // 監視する指標
  kind: RuleKind;
  // しきい値 (単位は kind により異なる。cost はマイクロ USD、他は 0〜1 の比率)
  threshold: number;
  // 集計窓 (分)
  windowMinutes: number;
  // 発火時の動作
  action: RuleAction;
  // 有効フラグ (無効化は削除ではなくこれを false にする)
  enabled: boolean;
  createdAt: Date;
}

// インシデント (ルール発火の記録。Step4)
export interface IncidentRecord {
  id: string;
  tenantId: string;
  agentId: string;
  ruleId: string;
  status: IncidentStatus;
  // 発火理由の要約 (通知本文にも使う。機微情報は入れない)
  summary: string;
  // 発火日時 (= 行の作成日時)。**名前を createdAt にそろえる**のは、一覧のカーソル
  // (src/data/page.ts) が「(createdAt, id) の組」を位置として符号化する唯一の規則だから
  createdAt: Date;
  resolvedAt: Date | null;
}

// 監査ログ (追記専用＋ハッシュ連鎖。Step4)。**payload は `unknown`** —
// DB の列は `Json?` で、形の保証はドメイン側の `isAuditPayload` が実行時に行う
// (型アサーションで「平坦な辞書である」と言い切ると、入れ子が混ざった行で検証が不定に揺れる)
export interface AuditLogRecord {
  id: string;
  tenantId: string;
  // 操作したユーザー (システム操作なら null)
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  payload: unknown;
  createdAt: Date;
  // テナントごとの連番 (1 始まり。連鎖の順序はこれだけが決める)
  seq: bigint;
  // 直前の行のハッシュ (テナントの最初の行だけ null)
  prevHash: string | null;
  // この行のハッシュ (HMAC-SHA256)
  hash: string;
}
