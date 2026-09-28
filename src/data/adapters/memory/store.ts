// memory アダプタが共有するインメモリの表 (テスト専用。プロセスを跨いで残らない)。
// 各 Port の実装はこの表を読み書きし、テストは seed のためにここへ直接行を入れられる
import type {
  AgentRecord,
  ApiKeyRecord,
  TenantRecord,
  UsageEventRecord,
  UserRecord,
  UserTokenRecord,
} from '@/data/ports';

// 表の束
// 連番 id の桁数 (0 埋め。テストで作る行数より十分大きい)
const ID_SEQUENCE_DIGITS = 6;

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
