// memory アダプタが共有するインメモリの表 (テスト専用。プロセスを跨いで残らない)。
// 各 Port の実装はこの表を読み書きし、テストは seed のためにここへ直接行を入れられる
import type {
  AgentRecord,
  ApiKeyRecord,
  AuditLogRecord,
  GuardrailRuleRecord,
  IncidentRecord,
  EvaluationCaseRecord,
  EvaluationResultRecord,
  EvaluationRunRecord,
  EvaluationSetRecord,
  TenantRecord,
  UsageEventRecord,
  UserRecord,
  UserTokenRecord,
} from '@/data/ports';

// 表の束
// 連番 id の桁数 (0 埋め。テストで作る行数より十分大きい)
const ID_SEQUENCE_DIGITS = 6;

/**
 * 受信した課金イベントの行 (memory 専用)。
 *
 * **Port には記録の可否 (`recorded` / `duplicate`) しか無いので、読み出しの契約が無い。**
 * 本番の表には調査用の索引があるが、アプリから読む経路はまだ作っていない (ADR-0012 の宿題)。
 * ここで持つのは「同じイベントを 2 回記録しない」ことを確かめるための最小限の形。
 */
export interface BillingEventRow {
  provider: string;
  eventId: string;
  type: string;
  tenantId: string | null;
  receivedAt: Date;
}

/**
 * レート制限の記録 1 本（memory 専用）。
 *
 * **キーは Port の `key` なので、行に `key` は持たない**（表の鍵が持っている）。
 * 本番の表（`RateLimitHit`）は `id` を持つが、アプリから id で引く経路が無いので写さない。
 */
export interface RateLimitHitRow {
  // 枠の種類（`standard` / `fanOut` / `outbound` / `heavyRead`）
  tier: string;
  // 呼び出しの時刻
  at: Date;
}

export class MemoryStore {
  // テナント (id → 行)
  readonly tenants = new Map<string, TenantRecord>();
  // ユーザー
  readonly users = new Map<string, UserRecord>();
  // ユーザートークン
  readonly userTokens = new Map<string, UserTokenRecord>();
  // エージェント
  readonly agents = new Map<string, AgentRecord>();
  // API キー
  readonly apiKeys = new Map<string, ApiKeyRecord>();
  // 利用イベント (プロキシが中継した呼び出しの記録)。本番の Restrict FK と同じく、
  // ここに行があるエージェントは削除できない (Step2 より前は Set の仮置きで模していた)
  readonly usageEvents = new Map<string, UsageEventRecord>();
  // 評価セット (LLM-as-judge の固定入力集合)
  readonly evaluationSets = new Map<string, EvaluationSetRecord>();
  // 評価ケース (親セット経由でしか触らない。テナントの絞り込みは親で行う)
  readonly evaluationCases = new Map<string, EvaluationCaseRecord>();
  // 評価実行 (本番の Restrict FK と同じく、ここに行があるエージェント・セットは削除できない)
  readonly evaluationRuns = new Map<string, EvaluationRunRecord>();
  // 採点結果 (実行 × ケース)
  readonly evaluationResults = new Map<string, EvaluationResultRecord>();
  // ガードレールのルール (本番の Restrict FK と同じく、インシデントを持つルールは削除できない)
  readonly guardrailRules = new Map<string, GuardrailRuleRecord>();
  // インシデント (ルール発火の記録)
  readonly incidents = new Map<string, IncidentRecord>();
  // 監査ログ。**追記専用を memory 側でも守る** — prisma 側では DB のトリガが守っている規律を
  // こちらにも置かないと、API テストだけが「書き換えられる世界」で通ってしまう (ADR-0006 の死角)
  readonly auditLogs = new Map<string, AuditLogRecord>();
  // 受信した課金イベント (冪等性の記録)。**キーは `provider:eventId`** — 本番は
  // `@@unique([provider, eventId])` が 2 行目を拒否するので、memory 側も「同じキーなら 2 行目を
  // 作らない」形にしておく (ADR-0006 の死角。緩いと API テストだけが二重処理を通してしまう)
  readonly billingEvents = new Map<string, BillingEventRow>();
  // レート制限の記録 (キー → その窓の中の呼び出し)。**業務データではない** —
  // 窓から外れた行は捨ててよい。prisma 側は 1 文の CTE で「掃く → 数える → 条件付きで足す」を
  // 行うので、こちらも同じ順で同じことをする (ADR-0006 の死角。緩いと API テストだけが
  // 「上限を超えても通る世界」で緑になる)
  readonly rateLimitHits = new Map<string, RateLimitHitRow[]>();
  // 採番用の連番 (cuid の代わり。テストで読みやすいよう接頭辞 + 連番にする)
  private sequence = 0;

  // 新しい id を発行する (接頭辞で種類が分かるようにする)
  nextId(kind: string): string {
    // 連番を進める
    this.sequence += 1;
    // 例: agent_000003。0 埋めするのは、同時刻の行を id の辞書順で並べたとき (compareCursorKeys) に挿入順と
    // 一致させるため (agent_10 < agent_9 になると prisma の cuid (単調増加) と並びが食い違い、順序に依存する
    // テストが時計次第で通ったり落ちたりする)
    return `${kind}_${String(this.sequence).padStart(ID_SEQUENCE_DIGITS, '0')}`;
  }

  // 現在時刻 (テストで時間を固定したいときはここを差し替える)
  now(): Date {
    // 実時刻を返す
    return new Date();
  }
}
