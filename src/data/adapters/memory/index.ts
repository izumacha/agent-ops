// memory アダプタ: Port をインメモリの表で実装する (API テスト用。DB 無しで本番と同じ経路を通す)。
// 本番 (prisma アダプタ) と挙動をそろえる要点: テナント絞り込み・一意制約 (DuplicateError)・
// ページネーションの並び順・削除の Restrict
import { DuplicateError } from '@/data/errors';
import type {
  AgentFilter,
  AgentRecord,
  AgentsPort,
  ApiKeyRecord,
  ApiKeysPort,
  CreateAgentInput,
  CreateApiKeyInput,
  CreateTenantInput,
  CreateTenantResult,
  CreateUserInput,
  CreateUserTokenInput,
  DeleteAgentResult,
  Page,
  PageQuery,
  Repositories,
  TenantRecord,
  TenantsPort,
  UpdateAgentInput,
  UserRecord,
  UserTokenLookup,
  UserTokenRecord,
  UserTokensPort,
  UsersPort,
} from '@/data/ports';
import { AgentStatus, Plan, Role, type AgentStatus as AgentStatusType } from '@/domain/types';
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
    // 表の全行をページに切る
    const page = paginate(this.store.tenants.values(), query);
    // 複製して返す
    return { ...page, items: page.items.map(clone) };
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
      plan: input.plan ?? Plan.free,
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
    // テナントで絞ってからページに切る
    const page = paginate(this.rowsOf(tenantId), query);
    return { ...page, items: page.items.map(clone) };
  }

  // id で引く (テナント境界を跨がない)
  async findById(tenantId: string, id: string): Promise<UserRecord | null> {
    // 行を取り出し、テナントが一致するときだけ返す
    const row = this.store.users.get(id);
    return row && row.tenantId === tenantId ? clone(row) : null;
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

  // 役割変更
  async updateRole(tenantId: string, id: string, role: Role): Promise<UserRecord | null> {
    // 対象行 (テナント境界内)
    const row = this.store.users.get(id);
    if (!row || row.tenantId !== tenantId) return null;
    // 役割と更新日時を書き換える
    row.role = role;
    row.updatedAt = this.store.now();
    return clone(row);
  }

  // 無効化
  async disable(tenantId: string, id: string): Promise<UserRecord | null> {
    // 対象行 (テナント境界内)
    const row = this.store.users.get(id);
    if (!row || row.tenantId !== tenantId) return null;
    // まだ有効なら無効化日時を入れる (既に無効なら最初の日時を保つ)
    row.disabledAt ??= this.store.now();
    row.updatedAt = this.store.now();
    return clone(row);
  }

  // 有効な admin の人数
  async countActiveAdmins(tenantId: string): Promise<number> {
    // 役割が admin かつ無効化されていない行を数える
    return this.rowsOf(tenantId).filter((row) => row.role === Role.admin && row.disabledAt === null)
      .length;
  }
}

// ユーザートークン Port の memory 実装
class MemoryUserTokens implements UserTokensPort {
  // 共有の表を受け取る
  constructor(private readonly store: MemoryStore) {}

  // 発行 (発行先が同テナントに無ければ null)
  async create(input: CreateUserTokenInput): Promise<UserTokenRecord | null> {
    // 発行先ユーザーがテナント内に存在すること
    const user = this.store.users.get(input.userId);
    if (!user || user.tenantId !== input.tenantId) return null;
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
    return clone(row);
  }

  // ハッシュで引く (認証経路)
  async findByHash(tokenHash: string): Promise<UserTokenLookup | null> {
    // ハッシュが一致する行 (tokenHash は一意)
    const token = [...this.store.userTokens.values()].find((row) => row.tokenHash === tokenHash);
    if (!token) return null;
    // 発行先ユーザー (FK があるので必ず居る)
    const user = this.store.users.get(token.userId);
    if (!user) return null;
    // 両方を複製して返す
    return { token: clone(token), user: clone(user) };
  }

  // あるユーザーのトークン一覧
  async list(tenantId: string, userId: string, query: PageQuery): Promise<Page<UserTokenRecord>> {
    // テナントとユーザーで絞る
    const rows = [...this.store.userTokens.values()].filter(
      (row) => row.tenantId === tenantId && row.userId === userId,
    );
    // ページに切る
    const page = paginate(rows, query);
    return { ...page, items: page.items.map(clone) };
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
    // ページに切る
    const page = paginate(rows, query);
    return { ...page, items: page.items.map(clone) };
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
  async setStatus(
    tenantId: string,
    id: string,
    status: AgentStatusType,
  ): Promise<AgentRecord | null> {
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
    // 履歴を持つエージェントは削除できない (本番では Restrict FK が拒否する)
    if (this.store.agentIdsWithHistory.has(id)) return 'restricted';
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
    const page = paginate(rows, query);
    return { ...page, items: page.items.map(clone) };
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
  };
}

// テストが表へ直接 seed できるよう型と実体を再公開する
export { MemoryStore };
