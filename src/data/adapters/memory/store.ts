// memory アダプタが共有するインメモリの表 (テスト専用。プロセスを跨いで残らない)。
// 各 Port の実装はこの表を読み書きし、テストは seed のためにここへ直接行を入れられる
import type {
  AgentRecord,
  ApiKeyRecord,
  TenantRecord,
  UserRecord,
  UserTokenRecord,
} from '@/data/ports';

// 表の束
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
  // 「履歴を持つ」とみなすエージェント id (本番では UsageEvent 等の Restrict FK が担う判定を模す)
  readonly agentIdsWithHistory = new Set<string>();
  // 採番用の連番 (cuid の代わり。テストで読みやすいよう接頭辞 + 連番にする)
  private sequence = 0;

  // 新しい id を発行する (接頭辞で種類が分かるようにする)
  nextId(kind: string): string {
    // 連番を進める
    this.sequence += 1;
    // 例: agent_3
    return `${kind}_${this.sequence}`;
  }

  // 現在時刻 (テストで時間を固定したいときはここを差し替える)
  now(): Date {
    // 実時刻を返す
    return new Date();
  }
}
