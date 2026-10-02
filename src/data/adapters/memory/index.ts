// memory アダプタ: Port をインメモリの表で実装する (API テスト用。DB 無しで本番と同じ経路を通す)。
// 本番 (prisma アダプタ) と挙動をそろえる要点: テナント絞り込み・一意制約 (DuplicateError)・
// ページネーションの並び順・削除の Restrict
import { nextAuditSeq } from '@/domain/audit/chain';
import { USAGE_ERROR_STATUS_FLOOR } from '@/domain/guardrail/rule';
import { DuplicateError } from '@/data/errors';
import type {
  ActiveRuleQuery,
  AgentFilter,
  AgentRecord,
  AgentsPort,
  AppendAuditLogInput,
  AuditHashInput,
  AuditLogRecord,
  AuditLogsPort,
  CreateGuardrailRuleInput,
  CreateGuardrailRuleResult,
  DeleteGuardrailRuleResult,
  GuardrailRuleRecord,
  GuardrailRulesPort,
  IncidentFilter,
  IncidentRecord,
  IncidentsPort,
  RaiseIncidentInput,
  RaisedIncident,
  ResolveIncidentResult,
  UsageWindowQuery,
  UsageWindowTotal,
  ApiKeyRecord,
  ApiKeysPort,
  CreateAgentInput,
  CreateApiKeyInput,
  CreateEvaluationRunInput,
  CreateEvaluationSetInput,
  CreateTenantInput,
  CreateTenantResult,
  CreateUserInput,
  CreateUserTokenInput,
  DailyUsageQuery,
  DailyUsageTotal,
  DeleteAgentResult,
  EvaluationCaseRecord,
  EvaluationResultRecord,
  EvaluationRunFilter,
  EvaluationRunRecord,
  EvaluationRunWithResults,
  EvaluationSetRecord,
  EvaluationSetWithCases,
  EvaluationsPort,
  ApiKeyLookup,
  Page,
  PageQuery,
  RecordUsageEventInput,
  Repositories,
  TenantRecord,
  TenantsPort,
  UpdateAgentInput,
  UsageEventRecord,
  UsageEventsPort,
  UserMutationResult,
  UserRecord,
  UserTokenLookup,
  UserTokenCreateResult,
  UserTokenRecord,
  UserTokensPort,
  UsersPort,
} from '@/data/ports';
import { AgentStatus, EvaluationRunStatus, IncidentStatus, Plan, Role } from '@/domain/types';
import { formatUtcDay } from '@/domain/usage-window';
import { compareCursorKeys } from '@/data/page';
import { paginate } from './paginate';
import { MemoryStore } from './store';

// 行の複製を返す (呼び出し側が戻り値を書き換えても表が壊れないようにする)
function clone<T>(row: T): T {
  // スプレッドで浅い複製 (行はプリミティブと Date だけなので十分)
  return { ...row };
}

// テナント Port の memory 実装
class MemoryTenants implements TenantsPort {
  // 共有の表を受け取る
  constructor(private readonly store: MemoryStore) {}

  // 全テナントを一覧する
  async list(query: PageQuery): Promise<Page<TenantRecord>> {
    // ページに切る (行の複製は paginate() が担う)
    return paginate(this.store.tenants.values(), query);
  }

  // id で引く
  async findById(id: string): Promise<TenantRecord | null> {
    // 見つかれば複製、無ければ null
    const row = this.store.tenants.get(id);
    return row ? clone(row) : null;
  }

  // テナント + admin + トークンを作る (メモリなので原子性は自明)
  async createWithAdmin(input: CreateTenantInput): Promise<CreateTenantResult> {
    // 作成時刻
    const now = this.store.now();
    // テナント行
    const tenant: TenantRecord = {
      id: this.store.nextId('tenant'),
      name: input.name,
      // プランは free から始める (prisma 実装と同じ。切り替えは後の Step)
      plan: Plan.free,
      createdAt: now,
      updatedAt: now,
    };
    // admin ユーザー行 (役割は必ず admin)
    const admin: UserRecord = {
      id: this.store.nextId('user'),
      tenantId: tenant.id,
      email: input.admin.email,
      name: input.admin.name,
      role: Role.admin,
      disabledAt: null,
      createdAt: now,
      updatedAt: now,
    };
    // トークン行
    const token: UserTokenRecord = {
      id: this.store.nextId('utok'),
      tenantId: tenant.id,
      userId: admin.id,
      prefix: input.token.prefix,
      tokenHash: input.token.tokenHash,
      name: input.token.name,
      createdAt: now,
      expiresAt: input.token.expiresAt,
      revokedAt: null,
    };
    // 3 行を表へ入れる
    this.store.tenants.set(tenant.id, tenant);
    this.store.users.set(admin.id, admin);
    this.store.userTokens.set(token.id, token);
    // 複製して返す
    return { tenant: clone(tenant), admin: clone(admin), token: clone(token) };
  }
}

// ユーザー Port の memory 実装
class MemoryUsers implements UsersPort {
  // 共有の表を受け取る
  constructor(private readonly store: MemoryStore) {}

  // テナント内のユーザーを列挙する内部ヘルパー
  private rowsOf(tenantId: string): UserRecord[] {
    // tenantId が一致する行だけ
    return [...this.store.users.values()].filter((row) => row.tenantId === tenantId);
  }

  // 一覧
  async list(tenantId: string, query: PageQuery): Promise<Page<UserRecord>> {
    // ページに切る (行の複製は paginate() が担う)
    return paginate(this.rowsOf(tenantId), query);
  }

  // id で引く (テナント境界を跨がない)
  async findById(tenantId: string, id: string): Promise<UserRecord | null> {
    // 行を取り出し、テナントが一致するときだけ返す
    const row = this.store.users.get(id);
    return row && row.tenantId === tenantId ? clone(row) : null;
  }

  // メールで引く (テナント内で一意)
  async findByEmail(tenantId: string, email: string): Promise<UserRecord | null> {
    // テナント内でメールが一致する行
    const row = this.rowsOf(tenantId).find((candidate) => candidate.email === email);
    return row ? clone(row) : null;
  }

  // 「この行を admin から外すと有効な admin が 0 人になるか」(行そのものは除いて数える)
  private wouldLeaveNoAdmin(row: UserRecord): boolean {
    // 対象が有効な admin でなければ人数は変わらない
    if (row.role !== Role.admin || row.disabledAt !== null) return false;
    // 対象以外の有効な admin が 1 人も居なければ拒否
    return !this.rowsOf(row.tenantId).some(
      (other) => other.id !== row.id && other.role === Role.admin && other.disabledAt === null,
    );
  }

  // 作成 (メール重複は DuplicateError)
  async create(input: CreateUserInput): Promise<UserRecord> {
    // 同テナントに同じメールがあれば一意制約違反
    if (this.rowsOf(input.tenantId).some((row) => row.email === input.email)) {
      throw new DuplicateError('email');
    }
    // 作成時刻
    const now = this.store.now();
    // 新しい行
    const row: UserRecord = {
      id: this.store.nextId('user'),
      tenantId: input.tenantId,
      email: input.email,
      name: input.name,
      role: input.role,
      disabledAt: null,
      createdAt: now,
      updatedAt: now,
    };
    // 表へ入れて複製を返す
    this.store.users.set(row.id, row);
    return clone(row);
  }

  // 役割変更 (判定と更新の間に await が無いので、メモリ実装では自明に原子的)
  async updateRole(tenantId: string, id: string, role: Role): Promise<UserMutationResult> {
    // 対象行 (テナント境界内)
    const row = this.store.users.get(id);
    if (!row || row.tenantId !== tenantId) return { status: 'not_found' };
    // 無効化済みのユーザーの役割は変えない (認証できない admin を作らない)
    if (row.disabledAt !== null) return { status: 'disabled' };
    // 最後の有効な admin を admin 以外へ変える要求は拒否する
    if (role !== Role.admin && this.wouldLeaveNoAdmin(row)) return { status: 'last_admin' };
    // 役割と更新日時を書き換える
    row.role = role;
    row.updatedAt = this.store.now();
    return { status: 'ok', user: clone(row) };
  }

  // 無効化 (判定と更新の間に await が無いので、メモリ実装では自明に原子的)
  async disable(tenantId: string, id: string): Promise<UserMutationResult> {
    // 対象行 (テナント境界内)
    const row = this.store.users.get(id);
    if (!row || row.tenantId !== tenantId) return { status: 'not_found' };
    // 最後の有効な admin は無効化できない
    if (this.wouldLeaveNoAdmin(row)) return { status: 'last_admin' };
    // まだ有効なら無効化日時と更新日時を入れる (既に無効なら prisma と同じく何も書き換えない)
    if (row.disabledAt === null) {
      row.disabledAt = this.store.now();
      row.updatedAt = row.disabledAt;
    }
    return { status: 'ok', user: clone(row) };
  }
}

// ユーザートークン Port の memory 実装
class MemoryUserTokens implements UserTokensPort {
  // 共有の表を受け取る
  constructor(private readonly store: MemoryStore) {}

  // 発行 (判定と挿入の間に await が無いので、メモリ実装では自明に原子的)
  async create(input: CreateUserTokenInput): Promise<UserTokenCreateResult> {
    // 発行先ユーザーがテナント内に存在すること
    const user = this.store.users.get(input.userId);
    if (!user || user.tenantId !== input.tenantId) return { status: 'not_found' };
    // 無効化済みのユーザーには発行しない
    if (user.disabledAt !== null) return { status: 'disabled' };
    // 新しい行
    const row: UserTokenRecord = {
      id: this.store.nextId('utok'),
      tenantId: input.tenantId,
      userId: input.userId,
      prefix: input.prefix,
      tokenHash: input.tokenHash,
      name: input.name,
      createdAt: this.store.now(),
      expiresAt: input.expiresAt,
      revokedAt: null,
    };
    // 表へ入れて複製を返す
    this.store.userTokens.set(row.id, row);
    return { status: 'ok', token: clone(row) };
  }

  // ハッシュで引く (認証経路)
  async findByHash(tokenHash: string): Promise<UserTokenLookup | null> {
    // ハッシュが一致する行 (tokenHash は一意)
    const token = [...this.store.userTokens.values()].find((row) => row.tokenHash === tokenHash);
    if (!token) return null;
    // 発行先ユーザー (FK があるので必ず居る)
    const user = this.store.users.get(token.userId);
    if (!user) return null;
    // **トークンと発行先のテナントが一致すること** — 本番は複合 FK (tenantId, userId) が
    // この組み合わせを作らせないが、memory の表は直接 seed できるので読み取り側でも確かめる
    // (書き込み側の create は既に確かめているのに、読み取り側だけが素通しだった)。
    // 食い違う行は「無い」ものとして扱う (§9 fail-closed)
    if (token.tenantId !== user.tenantId) return null;
    // 両方を複製して返す
    return { token: clone(token), user: clone(user) };
  }

  // あるユーザーのトークン一覧
  async list(tenantId: string, userId: string, query: PageQuery): Promise<Page<UserTokenRecord>> {
    // テナントとユーザーで絞る
    const rows = [...this.store.userTokens.values()].filter(
      (row) => row.tenantId === tenantId && row.userId === userId,
    );
    // ページに切る (行の複製は paginate() が担う)
    return paginate(rows, query);
  }

  // 失効
  async revoke(tenantId: string, userId: string, id: string): Promise<UserTokenRecord | null> {
    // 対象行 (テナント・ユーザー境界内)
    const row = this.store.userTokens.get(id);
    if (!row || row.tenantId !== tenantId || row.userId !== userId) return null;
    // まだ有効なら失効日時を入れる
    row.revokedAt ??= this.store.now();
    return clone(row);
  }
}

// エージェント Port の memory 実装
class MemoryAgents implements AgentsPort {
  // 共有の表を受け取る
  constructor(private readonly store: MemoryStore) {}

  // テナント内のエージェントを列挙する内部ヘルパー
  private rowsOf(tenantId: string): AgentRecord[] {
    // tenantId が一致する行だけ
    return [...this.store.agents.values()].filter((row) => row.tenantId === tenantId);
  }

  // 一覧 (状態で絞れる)
  async list(tenantId: string, query: PageQuery, filter?: AgentFilter): Promise<Page<AgentRecord>> {
    // テナントで絞り、状態の指定があればさらに絞る
    const rows = this.rowsOf(tenantId).filter(
      (row) => filter?.status === undefined || row.status === filter.status,
    );
    // ページに切る (行の複製は paginate() が担う)
    return paginate(rows, query);
  }

  // id で引く (テナント境界を跨がない)
  async findById(tenantId: string, id: string): Promise<AgentRecord | null> {
    // 行を取り出し、テナントが一致するときだけ返す
    const row = this.store.agents.get(id);
    return row && row.tenantId === tenantId ? clone(row) : null;
  }

  // 作成 (名前重複は DuplicateError)
  async create(input: CreateAgentInput): Promise<AgentRecord> {
    // 同テナントに同じ名前があれば一意制約違反
    if (this.rowsOf(input.tenantId).some((row) => row.name === input.name)) {
      throw new DuplicateError('name');
    }
    // 作成時刻
    const now = this.store.now();
    // 新しい行 (状態は active から始まる)
    const row: AgentRecord = {
      id: this.store.nextId('agent'),
      tenantId: input.tenantId,
      name: input.name,
      description: input.description,
      provider: input.provider,
      model: input.model,
      status: AgentStatus.active,
      budgetMicroUsd: input.budgetMicroUsd,
      createdAt: now,
      updatedAt: now,
    };
    // 表へ入れて複製を返す
    this.store.agents.set(row.id, row);
    return clone(row);
  }

  // 更新 (undefined は変更しない)
  async update(tenantId: string, id: string, patch: UpdateAgentInput): Promise<AgentRecord | null> {
    // 対象行 (テナント境界内)
    const row = this.store.agents.get(id);
    if (!row || row.tenantId !== tenantId) return null;
    // 名前を変えるときは他の行と重複しないこと
    if (
      patch.name !== undefined &&
      this.rowsOf(tenantId).some((other) => other.id !== id && other.name === patch.name)
    ) {
      throw new DuplicateError('name');
    }
    // 指定されたプロパティだけ書き換える
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.description !== undefined) row.description = patch.description;
    if (patch.model !== undefined) row.model = patch.model;
    if (patch.budgetMicroUsd !== undefined) row.budgetMicroUsd = patch.budgetMicroUsd;
    // 更新日時
    row.updatedAt = this.store.now();
    return clone(row);
  }

  // 状態変更
  async setStatus(tenantId: string, id: string, status: AgentStatus): Promise<AgentRecord | null> {
    // 対象行 (テナント境界内)
    const row = this.store.agents.get(id);
    if (!row || row.tenantId !== tenantId) return null;
    // 状態と更新日時を書き換える
    row.status = status;
    row.updatedAt = this.store.now();
    return clone(row);
  }

  // 削除 (履歴があれば restricted)
  async delete(tenantId: string, id: string): Promise<DeleteAgentResult> {
    // 対象行 (テナント境界内)
    const row = this.store.agents.get(id);
    if (!row || row.tenantId !== tenantId) return 'not_found';
    // 履歴 (利用イベント・評価実行) を持つエージェントは削除できない (本番では Restrict FK が拒否する)
    const hasUsage = [...this.store.usageEvents.values()].some((event) => event.agentId === id);
    const hasRuns = [...this.store.evaluationRuns.values()].some((run) => run.agentId === id);
    if (hasUsage || hasRuns) return 'restricted';
    // 設定 (API キー) は一緒に消える (本番の Cascade と同じ)
    for (const [keyId, key] of this.store.apiKeys) {
      if (key.agentId === id) this.store.apiKeys.delete(keyId);
    }
    // 本体を消す
    this.store.agents.delete(id);
    return 'deleted';
  }
}

// API キー Port の memory 実装
class MemoryApiKeys implements ApiKeysPort {
  // 共有の表を受け取る
  constructor(private readonly store: MemoryStore) {}

  // 一覧 (失効済みも含む)
  async list(tenantId: string, query: PageQuery): Promise<Page<ApiKeyRecord>> {
    // テナントで絞ってページに切る
    const rows = [...this.store.apiKeys.values()].filter((row) => row.tenantId === tenantId);
    // ページに切る (行の複製は paginate() が担う)
    return paginate(rows, query);
  }

  // id で引く (テナント境界を跨がない)
  async findById(tenantId: string, id: string): Promise<ApiKeyRecord | null> {
    // 行を取り出し、テナントが一致するときだけ返す
    const row = this.store.apiKeys.get(id);
    return row && row.tenantId === tenantId ? clone(row) : null;
  }

  // 発行 (agentId が同テナントに無ければ null)
  async create(input: CreateApiKeyInput): Promise<ApiKeyRecord | null> {
    // エージェントを指定するなら、同テナントに存在すること (本番では複合 FK が担う)
    if (input.agentId !== null) {
      const agent = this.store.agents.get(input.agentId);
      if (!agent || agent.tenantId !== input.tenantId) return null;
    }
    // 新しい行
    const row: ApiKeyRecord = {
      id: this.store.nextId('key'),
      tenantId: input.tenantId,
      agentId: input.agentId,
      prefix: input.prefix,
      keyHash: input.keyHash,
      name: input.name,
      createdAt: this.store.now(),
      revokedAt: null,
    };
    // 表へ入れて複製を返す
    this.store.apiKeys.set(row.id, row);
    return clone(row);
  }

  // ハッシュで引く (プロキシの認証経路。テナントを跨いで検索する唯一の操作)
  async findByHash(keyHash: string): Promise<ApiKeyLookup | null> {
    // ハッシュが一致する行を探す (本番では keyHash が一意なので高々 1 件)
    const key = [...this.store.apiKeys.values()].find((row) => row.keyHash === keyHash);
    // 無ければ null (失効済みかどうかは呼び出し側が見る)
    if (!key) return null;
    // 紐づくエージェントを同時に取る (テナント共通キーなら null のまま)
    const agent = key.agentId === null ? null : (this.store.agents.get(key.agentId) ?? null);
    // **キーと紐づくエージェントのテナントが一致すること** — 本番は複合 FK (tenantId, agentId)
    // がこの組み合わせを作らせないが、memory の表は直接 seed できる。
    // 認証は `found.agent.tenantId` を主体のテナントに採るので、食い違う行を返すと
    // 「テナント A のキーがテナント B のエージェントとして認証される」形になる (§9 fail-closed)
    if (agent !== null && agent.tenantId !== key.tenantId) return null;
    // キーと複製したエージェントを返す
    return { key: clone(key), agent: agent === null ? null : clone(agent) };
  }

  // 失効
  async revoke(tenantId: string, id: string): Promise<ApiKeyRecord | null> {
    // 対象行 (テナント境界内)
    const row = this.store.apiKeys.get(id);
    if (!row || row.tenantId !== tenantId) return null;
    // まだ有効なら失効日時を入れる
    row.revokedAt ??= this.store.now();
    return clone(row);
  }
}

// 利用イベント Port の memory 実装
class MemoryUsageEvents implements UsageEventsPort {
  // 共有の表を受け取る
  constructor(private readonly store: MemoryStore) {}

  // 1 回の呼び出しを記録する (エージェントが同テナントに無ければ null)
  async record(input: RecordUsageEventInput): Promise<UsageEventRecord | null> {
    // 記録先のエージェント (本番では複合 FK (tenantId, agentId) が同じ判定をする)
    const agent = this.store.agents.get(input.agentId);
    // 同テナントに居なければ記録しない
    if (!agent || agent.tenantId !== input.tenantId) return null;
    // 新しい行 (発生日時は表の時計から取る)
    const row: UsageEventRecord = {
      id: this.store.nextId('usage'),
      tenantId: input.tenantId,
      agentId: input.agentId,
      provider: input.provider,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      costMicroUsd: input.costMicroUsd,
      latencyMs: input.latencyMs,
      statusCode: input.statusCode,
      createdAt: this.store.now(),
    };
    // 表へ入れて複製を返す
    this.store.usageEvents.set(row.id, row);
    return clone(row);
  }

  // 任意の半開区間を 1 つの合計にまとめる (ガードレールの判定が使う。prisma 側の SQL と同じ規則)
  async windowTotals(tenantId: string, query: UsageWindowQuery): Promise<UsageWindowTotal> {
    // 合計を貯める (呼び出し回数・失敗した回数・料金)
    let requests = 0;
    let errorRequests = 0;
    let costMicroUsd = 0n;
    // テナント・期間・エージェントで絞りながら足し込む
    for (const event of this.store.usageEvents.values()) {
      // 他テナントの行は数えない
      if (event.tenantId !== tenantId) continue;
      // 期間は半開区間 (開始は含み、終了は含まない)
      if (event.createdAt < query.start || event.createdAt >= query.endExclusive) continue;
      // エージェントの指定があれば一致する行だけ
      if (query.agentId !== undefined && event.agentId !== query.agentId) continue;
      // 呼び出し回数を数える (エラー率の分母)
      requests += 1;
      // 上流の HTTP ステータスが 400 以上なら失敗として数える (エラー率の分子)
      if (event.statusCode >= USAGE_ERROR_STATUS_FLOOR) errorRequests += 1;
      // 料金を足す
      costMicroUsd += event.costMicroUsd;
    }
    // 窓の合計
    return { requests, errorRequests, costMicroUsd };
  }

  // 期間内を UTC の日ごとに集計する (prisma 側の SQL と同じ規則。日の境目は src/domain/usage-window.ts)
  async dailyTotals(tenantId: string, query: DailyUsageQuery): Promise<DailyUsageTotal[]> {
    // 日ごとの合計を貯める表
    const totals = new Map<string, DailyUsageTotal>();
    // テナント・期間・エージェントで絞りながら足し込む
    for (const event of this.store.usageEvents.values()) {
      // 他テナントの行は数えない
      if (event.tenantId !== tenantId) continue;
      // 期間は半開区間 (開始は含み、終了は含まない)
      if (event.createdAt < query.start || event.createdAt >= query.endExclusive) continue;
      // エージェントの指定があれば一致する行だけ
      if (query.agentId !== undefined && event.agentId !== query.agentId) continue;
      // その行が属する UTC の日
      const day = formatUtcDay(event.createdAt);
      // その日の合計 (初回は 0 から始める)
      const total = totals.get(day) ?? {
        day,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        costMicroUsd: 0n,
      };
      // 回数とトークン・料金を足す
      total.requests += 1;
      total.inputTokens += event.inputTokens;
      total.outputTokens += event.outputTokens;
      total.costMicroUsd += event.costMicroUsd;
      // 表へ戻す
      totals.set(day, total);
    }
    // 日の昇順に並べて返す (SQL 側の ORDER BY と同じ)
    return [...totals.values()].sort((left, right) => left.day.localeCompare(right.day));
  }
}

// 評価 Port の memory 実装
class MemoryEvaluations implements EvaluationsPort {
  // 共有の表を受け取る
  constructor(private readonly store: MemoryStore) {}

  // 評価セットを作る (名前が重複していれば DuplicateError)
  async createSet(input: CreateEvaluationSetInput): Promise<EvaluationSetWithCases> {
    // 同じテナントに同じ名前のセットがあれば拒否する (本番の @@unique([tenantId, name]) と同じ)
    for (const existing of this.store.evaluationSets.values()) {
      if (existing.tenantId === input.tenantId && existing.name === input.name) {
        throw new DuplicateError('name');
      }
    }
    // セット本体
    const set: EvaluationSetRecord = {
      id: this.store.nextId('evalset'),
      tenantId: input.tenantId,
      name: input.name,
      createdAt: this.store.now(),
    };
    // 表へ入れる
    this.store.evaluationSets.set(set.id, set);
    // ケースを配列の順に入れる (その順が position になる)
    const cases = input.cases.map((item, index): EvaluationCaseRecord => {
      // 1 ケース分の行
      const row: EvaluationCaseRecord = {
        id: this.store.nextId('evalcase'),
        setId: set.id,
        position: index,
        input: item.input,
        expected: item.expected,
      };
      // 表へ入れる
      this.store.evaluationCases.set(row.id, row);
      return row;
    });
    // 複製を返す (呼び出し側の書き換えで表が壊れないようにする)
    return { set: clone(set), cases: cases.map(clone) };
  }

  // 評価セットを一覧する (テナント内)
  async listSets(tenantId: string, query: PageQuery): Promise<Page<EvaluationSetRecord>> {
    // テナントで絞ってからページに切る
    const rows = [...this.store.evaluationSets.values()].filter((row) => row.tenantId === tenantId);
    return paginate(rows, query);
  }

  // 評価セットをケースごと引く (他テナントのセットは null)
  async findSet(tenantId: string, setId: string): Promise<EvaluationSetWithCases | null> {
    // セット本体 (テナント境界内)
    const set = this.store.evaluationSets.get(setId);
    if (!set || set.tenantId !== tenantId) return null;
    // そのセットのケースを position 昇順で集める
    const cases = [...this.store.evaluationCases.values()]
      .filter((row) => row.setId === setId)
      .sort((left, right) => left.position - right.position);
    // 複製を返す
    return { set: clone(set), cases: cases.map(clone) };
  }

  // 実行結果を保存する (エージェントかセットが同テナントに無ければ null)
  async createRun(input: CreateEvaluationRunInput): Promise<EvaluationRunWithResults | null> {
    // 対象エージェント (本番では複合 FK (tenantId, agentId) が同じ判定をする)
    const agent = this.store.agents.get(input.agentId);
    if (!agent || agent.tenantId !== input.tenantId) return null;
    // 使ったセット (同じく複合 FK (tenantId, setId) の判定)
    const set = this.store.evaluationSets.get(input.setId);
    if (!set || set.tenantId !== input.tenantId) return null;
    // そのセットに実在するケース ID の集合 (本番では複合 FK (setId, caseId) が同じ判定をする)
    const caseIds = new Set(
      [...this.store.evaluationCases.values()]
        .filter((row) => row.setId === input.setId)
        .map((row) => row.id),
    );
    // **セット外のケース ID が 1 つでも混ざっていたら丸ごと断る** — prisma 側は複合 FK 違反で
    // null になるので、ここで通すと memory だけ「別セットのケースの採点」を保存でき、
    // API テスト (memory) と契約テスト (prisma) で挙動が割れる
    if (input.results.some((item) => !caseIds.has(item.caseId))) return null;
    // **同じケースの結果が 2 つ以上あっても断る** — prisma 側は一意制約 @@unique([runId, caseId])
    // で止まるが、そちらは一意制約違反 (FK 違反ではない) なので createRun が null に写さず
    // 例外のまま抜ける = HTTP 500 になる。memory がここで通すと、その形が API テストでは
    // 緑のまま通り、本番でだけ 500 になる (しかも上流の呼び出しは済んでいる)
    if (new Set(input.results.map((item) => item.caseId)).size !== input.results.length) {
      return null;
    }
    // 実行本体
    const run: EvaluationRunRecord = {
      id: this.store.nextId('evalrun'),
      tenantId: input.tenantId,
      agentId: input.agentId,
      setId: input.setId,
      accuracy: input.accuracy,
      safety: input.safety,
      deviation: input.deviation,
      status: input.status,
      scoredCases: input.scoredCases,
      excludedCases: input.excludedCases,
      judgeProvider: input.judgeProvider,
      judgeModel: input.judgeModel,
      createdAt: this.store.now(),
    };
    // 表へ入れる
    this.store.evaluationRuns.set(run.id, run);
    // ケース単位の結果を入れる
    const results = input.results.map((item): EvaluationResultRecord => {
      // 1 件分の行
      const row: EvaluationResultRecord = {
        id: this.store.nextId('evalresult'),
        tenantId: input.tenantId,
        runId: run.id,
        setId: input.setId,
        caseId: item.caseId,
        accuracy: item.accuracy,
        safety: item.safety,
        deviation: item.deviation,
        excludedReason: item.excludedReason,
      };
      // 表へ入れる
      this.store.evaluationResults.set(row.id, row);
      return row;
    });
    // 複製を返す
    return { run: clone(run), results: results.map(clone) };
  }

  // 実行を一覧する (テナント内。エージェント・セットで絞れる)
  async listRuns(
    tenantId: string,
    query: PageQuery,
    filter: EvaluationRunFilter = {},
  ): Promise<Page<EvaluationRunRecord>> {
    // テナントと絞り込み条件で残す行を決める
    const rows = [...this.store.evaluationRuns.values()].filter((row) => {
      // 他テナントの行は出さない
      if (row.tenantId !== tenantId) return false;
      // エージェントの指定があれば一致する行だけ
      if (filter.agentId !== undefined && row.agentId !== filter.agentId) return false;
      // セットの指定があれば一致する行だけ
      if (filter.setId !== undefined && row.setId !== filter.setId) return false;
      return true;
    });
    // ページに切る
    return paginate(rows, query);
  }

  // 実行を結果ごと引く (他テナントの実行は null)
  async findRun(tenantId: string, runId: string): Promise<EvaluationRunWithResults | null> {
    // 実行本体 (テナント境界内)
    const run = this.store.evaluationRuns.get(runId);
    if (!run || run.tenantId !== tenantId) return null;
    // ケースの position 昇順に並べたいので、ケースの位置を引けるようにする
    const positions = new Map(
      [...this.store.evaluationCases.values()].map((row) => [row.id, row.position]),
    );
    // その実行の結果を集めて並べる
    const results = [...this.store.evaluationResults.values()]
      .filter((row) => row.runId === runId)
      .sort(
        (left, right) => (positions.get(left.caseId) ?? 0) - (positions.get(right.caseId) ?? 0),
      );
    // 複製を返す
    return { run: clone(run), results: results.map(clone) };
  }

  // 同じエージェント × セットの、その実行より前の最新の実行 (回帰比較の相手)
  async findPreviousRun(
    tenantId: string,
    run: EvaluationRunRecord,
  ): Promise<EvaluationRunRecord | null> {
    // 同じ組み合わせで、位置がその実行より前の行だけを残す。
    // **failed の実行は比較相手にしない** — 除外が多すぎてスコアが null なので、
    // 比べても差が出ず「前回より下がった/上がった」を判定できない
    // (prisma/schema.prisma の status の説明どおり、回帰比較の材料から外す)
    const candidates = [...this.store.evaluationRuns.values()].filter(
      (row) =>
        row.tenantId === tenantId &&
        row.agentId === run.agentId &&
        row.setId === run.setId &&
        row.status === EvaluationRunStatus.completed &&
        // **同じ judge で採点した実行だけを相手にする** (理由は prisma アダプタと同じ)
        row.judgeProvider === run.judgeProvider &&
        row.judgeModel === run.judgeModel &&
        compareCursorKeys(row, run) < 0,
    );
    // 1 つも無ければ比較相手が無い (初回の実行)
    if (candidates.length === 0) return null;
    // 並べて最後 (= 直前) を返す
    candidates.sort(compareCursorKeys);
    return clone(candidates[candidates.length - 1]);
  }

  // そのエージェントの最新の completed な実行 (品質低下ルールが読む相手)
  async findLatestCompletedRun(
    tenantId: string,
    agentId: string,
  ): Promise<EvaluationRunRecord | null> {
    // テナント・エージェントが一致し、採点が成立した実行だけを集める
    const candidates = [...this.store.evaluationRuns.values()].filter(
      (row) =>
        row.tenantId === tenantId &&
        row.agentId === agentId &&
        row.status === EvaluationRunStatus.completed,
    );
    // 1 件も無ければ測れていない (ルールは発火しない)
    if (candidates.length === 0) return null;
    // 並べて最後 (= 最新) を返す
    candidates.sort(compareCursorKeys);
    return clone(candidates[candidates.length - 1]);
  }
}

// ── ガードレールのルール ──────────────────────────
class MemoryGuardrailRules implements GuardrailRulesPort {
  // 共有の表を受け取る
  constructor(private readonly store: MemoryStore) {}

  // ルールを作る (上限に達していれば作らない。prisma 側はこれを 1 トランザクションで行う)
  async create(
    input: CreateGuardrailRuleInput,
    maxRulesPerTenant: number,
  ): Promise<CreateGuardrailRuleResult> {
    // 対象エージェントの指定があれば、同テナントに居ることを確かめる (本番では複合 FK が同じ判定をする)
    if (input.agentId !== null) {
      // 指定されたエージェントを引く
      const agent = this.store.agents.get(input.agentId);
      // 他テナントのエージェント・存在しないエージェントは作成できない
      if (!agent || agent.tenantId !== input.tenantId) return { status: 'agent_not_found' };
    }
    // そのテナントの現在のルール数
    const existing = [...this.store.guardrailRules.values()].filter(
      (row) => row.tenantId === input.tenantId,
    ).length;
    // 上限に達していれば作らない (判定は中継 1 回ごとに走るので件数を縛る)
    if (existing >= maxRulesPerTenant) return { status: 'too_many_rules' };
    // 新しい行 (作成日時は表の時計から取る)
    const row: GuardrailRuleRecord = {
      id: this.store.nextId('rule'),
      tenantId: input.tenantId,
      agentId: input.agentId,
      kind: input.kind,
      threshold: input.threshold,
      windowMinutes: input.windowMinutes,
      action: input.action,
      enabled: true,
      createdAt: this.store.now(),
    };
    // 表へ入れて複製を返す
    this.store.guardrailRules.set(row.id, row);
    return { status: 'created', rule: clone(row) };
  }

  // ルールを一覧する (テナント内、createdAt 昇順)
  async list(tenantId: string, query: PageQuery): Promise<Page<GuardrailRuleRecord>> {
    // テナントで絞ってから共通のページネーションに通す
    const rows = [...this.store.guardrailRules.values()].filter((row) => row.tenantId === tenantId);
    return paginate(rows, query);
  }

  // ルールを消す (インシデントを持つルールは消せない = 本番の Restrict FK と同じ)
  async delete(tenantId: string, ruleId: string): Promise<DeleteGuardrailRuleResult> {
    // 対象のルール
    const rule = this.store.guardrailRules.get(ruleId);
    // 他テナントのルール・存在しないルールは「無い」
    if (!rule || rule.tenantId !== tenantId) return 'not_found';
    // そのルールが起こしたインシデントがあるか (「なぜ止まったか」の記録なので消させない)
    const hasIncidents = [...this.store.incidents.values()].some((row) => row.ruleId === ruleId);
    // あれば消せない (無効化は enabled を false にする)
    if (hasIncidents) return 'restricted';
    // 消して結果を返す
    this.store.guardrailRules.delete(ruleId);
    return 'deleted';
  }

  // 判定の対象になる有効なルールを引く (エージェント指定のものとテナント全体のものの和集合)
  async findActiveRules(tenantId: string, query: ActiveRuleQuery): Promise<GuardrailRuleRecord[]> {
    // 種別の絞り込み (指定が無ければ全種別)
    const kinds = query.kinds;
    // テナント内の有効なルールのうち、対象エージェント向けかテナント全体のものを集める
    const rows = [...this.store.guardrailRules.values()].filter(
      (row) =>
        row.tenantId === tenantId &&
        row.enabled &&
        (row.agentId === null || row.agentId === query.agentId) &&
        (kinds === undefined || kinds.includes(row.kind)),
    );
    // 並びを決定的にしてから複製を返す (prisma 側の ORDER BY と同じ順序)
    rows.sort(compareCursorKeys);
    return rows.map((row) => clone(row));
  }
}

// ── インシデント ──────────────────────────
class MemoryIncidents implements IncidentsPort {
  // 共有の表を受け取る
  constructor(private readonly store: MemoryStore) {}

  // 発火を記録し、必要ならエージェントを停止する (prisma 側はこれを 1 トランザクションで行う)
  async raise(input: RaiseIncidentInput): Promise<RaisedIncident | null> {
    // 対象エージェント (本番では複合 FK (tenantId, agentId) が同じ判定をする)
    const agent = this.store.agents.get(input.agentId);
    // 同テナントに居なければ記録しない
    if (!agent || agent.tenantId !== input.tenantId) return null;
    // 発火したルール (本番では複合 FK (tenantId, ruleId) が同じ判定をする)
    const rule = this.store.guardrailRules.get(input.ruleId);
    // 同テナントに無ければ記録しない
    if (!rule || rule.tenantId !== input.tenantId) return null;
    // 新しいインシデント (発火日時は表の時計から取る)
    const row: IncidentRecord = {
      id: this.store.nextId('incident'),
      tenantId: input.tenantId,
      agentId: input.agentId,
      ruleId: input.ruleId,
      status: IncidentStatus.open,
      summary: input.summary,
      createdAt: this.store.now(),
      resolvedAt: null,
    };
    // 表へ入れる
    this.store.incidents.set(row.id, row);
    // 停止を要求されていて、かつ今が稼働中なら suspended にする。
    // **既に stopped / suspended のときは状態を変えない** — 手動停止を自動停止で塗り替えると、
    // 復帰の判断 (誰が止めたのか) が読めなくなる
    const suspended = input.suspendAgent && agent.status === AgentStatus.active;
    // 状態を変えるときだけ書き戻す
    if (suspended) this.store.agents.set(agent.id, { ...agent, status: AgentStatus.suspended });
    // 記録と「実際に止めたか」を返す
    return { incident: clone(row), suspended };
  }

  // インシデントを一覧する (テナント内、createdAt 昇順。絞り込みは任意)
  async list(
    tenantId: string,
    query: PageQuery,
    filter?: IncidentFilter,
  ): Promise<Page<IncidentRecord>> {
    // テナントと絞り込み条件で選ぶ
    const rows = [...this.store.incidents.values()].filter(
      (row) =>
        row.tenantId === tenantId &&
        (filter?.agentId === undefined || row.agentId === filter.agentId) &&
        (filter?.status === undefined || row.status === filter.status),
    );
    // 共通のページネーションに通す
    return paginate(rows, query);
  }

  // インシデントを引く (他テナントのものは null)
  async findById(tenantId: string, incidentId: string): Promise<IncidentRecord | null> {
    // 対象の行
    const row = this.store.incidents.get(incidentId);
    // 他テナントのものは「無い」(存在を隠す)
    return row && row.tenantId === tenantId ? clone(row) : null;
  }

  // 解決済みにする (既に解決済みなら 'already_resolved')
  async resolve(tenantId: string, incidentId: string): Promise<ResolveIncidentResult> {
    // 対象の行
    const row = this.store.incidents.get(incidentId);
    // 他テナントのものは「無い」
    if (!row || row.tenantId !== tenantId) return 'not_found';
    // 既に解決済みなら二重に記録しない (監査ログに同じ操作を何度も残さないため)
    if (row.status === IncidentStatus.resolved) return 'already_resolved';
    // 解決済みにして解決日時を入れる
    this.store.incidents.set(row.id, {
      ...row,
      status: IncidentStatus.resolved,
      resolvedAt: this.store.now(),
    });
    return 'resolved';
  }
}

// ── 監査ログ ──────────────────────────
class MemoryAuditLogs implements AuditLogsPort {
  // 共有の表を受け取る
  constructor(private readonly store: MemoryStore) {}

  // 1 行を追記する (連番の採番と連鎖の結線をここで行う。prisma 側は直前の行をロックしてから同じことをする)
  async append(
    input: AppendAuditLogInput,
    computeHash: (hashInput: AuditHashInput) => string,
  ): Promise<AuditLogRecord> {
    // そのテナントの直前の行 (seq が最大のもの)
    const previous = this.latestOf(input.tenantId);
    // 次の連番 (直前が無ければ 1)
    const seq = nextAuditSeq(previous?.seq ?? null);
    // 直前の行のハッシュ (最初の行は null)
    const prevHash = previous?.hash ?? null;
    // 新しい行の id (ハッシュの入力に入るので採番より前に決める)
    const id = this.store.nextId('audit');
    // ハッシュを計算してもらう (鍵と計算方法はアプリ側が持つ。アダプタは鍵に触らない)
    const hash = computeHash({ seq, prevHash, id });
    // 保存する行
    const row: AuditLogRecord = {
      id,
      tenantId: input.tenantId,
      actorId: input.actorId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      payload: input.payload,
      createdAt: input.createdAt,
      seq,
      prevHash,
      hash,
    };
    // 表へ入れて複製を返す
    this.store.auditLogs.set(row.id, row);
    return clone(row);
  }

  // 一覧する (テナント内、createdAt 昇順)
  async list(tenantId: string, query: PageQuery): Promise<Page<AuditLogRecord>> {
    // テナントで絞ってから共通のページネーションに通す
    const rows = [...this.store.auditLogs.values()].filter((row) => row.tenantId === tenantId);
    return paginate(rows, query);
  }

  // 連鎖の検証のために seq 昇順で読む (上限付き)
  async readChain(
    tenantId: string,
    limit: number,
  ): Promise<{ rows: AuditLogRecord[]; reachedLimit: boolean }> {
    // テナントの行を seq の昇順に並べる
    const all = [...this.store.auditLogs.values()]
      .filter((row) => row.tenantId === tenantId)
      .sort((left, right) => (left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0));
    // 上限までに切る
    const rows = all.slice(0, limit).map((row) => clone(row));
    // 上限に達したか (呼び出し側が「まだ続きがある」と伝えられるようにする)
    return { rows, reachedLimit: all.length > limit };
  }

  // そのテナントの直前の行 (seq が最大のもの。無ければ undefined)
  private latestOf(tenantId: string): AuditLogRecord | undefined {
    // 最大の seq を持つ行を探す
    let latest: AuditLogRecord | undefined;
    for (const row of this.store.auditLogs.values()) {
      // 他テナントの行は連鎖が別なので見ない
      if (row.tenantId !== tenantId) continue;
      // より大きい seq の行で置き換える
      if (latest === undefined || row.seq > latest.seq) latest = row;
    }
    // 見つかった行 (無ければ undefined)
    return latest;
  }
}

// memory アダプタ一式を組み立てる (テストはこれを setReposForTesting へ渡し、store で seed する)
export function createMemoryRepos(store: MemoryStore = new MemoryStore()): Repositories & {
  store: MemoryStore;
} {
  // 各 Port を同じ表で結線して返す
  return {
    store,
    tenants: new MemoryTenants(store),
    users: new MemoryUsers(store),
    userTokens: new MemoryUserTokens(store),
    agents: new MemoryAgents(store),
    apiKeys: new MemoryApiKeys(store),
    usageEvents: new MemoryUsageEvents(store),
    evaluations: new MemoryEvaluations(store),
    guardrailRules: new MemoryGuardrailRules(store),
    incidents: new MemoryIncidents(store),
    auditLogs: new MemoryAuditLogs(store),
  };
}

// テストが表へ直接 seed できるよう型と実体を再公開する
export { MemoryStore };
