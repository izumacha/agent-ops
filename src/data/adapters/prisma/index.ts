// prisma アダプタ: Port を Prisma (PostgreSQL) で実装する (本番用)。
// Prisma を直接 import してよいのはこのディレクトリと結線箇所 (src/lib/prisma*.ts) だけ (ESLint が強制する)。
// テナント絞り込みは全クエリの where に必ず入れる (ADR-0002)
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
import { Plan, Role, type AgentStatus } from '@/domain/types';
import { Prisma, type PrismaClient } from '@/generated/prisma';

// Prisma のエラーコード (https://www.prisma.io/docs/reference/api-reference/error-reference)
// 一意制約違反
const UNIQUE_VIOLATION = 'P2002';
// 外部キー制約違反 (Restrict による削除拒否もこれ)
const FOREIGN_KEY_VIOLATION = 'P2003';

// Prisma の既知エラーが指定コードかを判定する
function isPrismaError(error: unknown, code: string): boolean {
  // 既知エラー型で、かつコードが一致するとき true
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

// 一意制約違反なら DuplicateError へ翻訳して投げ、それ以外はそのまま投げ直す
function rethrowDuplicate(error: unknown, field: string): never {
  // 一意制約違反はデータ層の型へ翻訳する
  if (isPrismaError(error, UNIQUE_VIOLATION)) throw new DuplicateError(field);
  // それ以外は握り潰さず投げ直す
  throw error;
}

// 一覧の共通引数: createdAt → id の安定順、カーソルは前ページ最終行の id、1 件多く取って次ページを判定する
function pageArgs(query: PageQuery) {
  // 並び順・件数・カーソルをまとめて返す (cursor 指定時は skip:1 でカーソル行自身を除く)
  return {
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    take: query.limit + 1,
    ...(query.cursor !== undefined ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  };
}

// 1 件多く取った結果を Page へ整形する
function toPage<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  // 次ページがあるか (limit+1 件取れたか)
  const hasMore = rows.length > limit;
  // 返す分だけに切り詰める
  const items = hasMore ? rows.slice(0, limit) : rows;
  // 次ページがあれば最終行の id をカーソルにする
  return hasMore ? { items, nextCursor: items[items.length - 1].id } : { items };
}

// トランザクション内外の両方で使えるクライアント型
type Db = PrismaClient | Prisma.TransactionClient;

// テナント Port の prisma 実装
class PrismaTenants implements TenantsPort {
  // クライアントを受け取る
  constructor(private readonly db: PrismaClient) {}

  // 全テナントを一覧する (プラットフォーム管理者専用。テナント境界の外側)
  async list(query: PageQuery): Promise<Page<TenantRecord>> {
    // 1 件多く取って Page へ整形する
    const rows = await this.db.tenant.findMany(pageArgs(query));
    return toPage(rows, query.limit);
  }

  // id で引く
  async findById(id: string): Promise<TenantRecord | null> {
    // 主キーで検索する
    return this.db.tenant.findUnique({ where: { id } });
  }

  // テナント + admin + トークンを 1 トランザクションで作る
  async createWithAdmin(input: CreateTenantInput): Promise<CreateTenantResult> {
    // 途中で失敗したらすべて巻き戻す (admin のいないテナントを残さない)
    return this.db.$transaction(async (tx: Db) => {
      // テナント行
      const tenant = await tx.tenant.create({
        data: { name: input.name, plan: input.plan ?? Plan.free },
      });
      // admin ユーザー行 (役割は必ず admin)
      const admin = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: input.admin.email,
          name: input.admin.name,
          role: Role.admin,
        },
      });
      // トークン行
      const token = await tx.userToken.create({
        data: {
          tenantId: tenant.id,
          userId: admin.id,
          prefix: input.token.prefix,
          tokenHash: input.token.tokenHash,
          name: input.token.name,
          expiresAt: input.token.expiresAt,
        },
      });
      // 3 行を返す
      return { tenant, admin, token };
    });
  }
}

// ユーザー Port の prisma 実装
class PrismaUsers implements UsersPort {
  // クライアントを受け取る
  constructor(private readonly db: PrismaClient) {}

  // 一覧 (テナントで絞る)
  async list(tenantId: string, query: PageQuery): Promise<Page<UserRecord>> {
    // テナント条件 + ページ引数
    const rows = await this.db.user.findMany({ where: { tenantId }, ...pageArgs(query) });
    return toPage(rows, query.limit);
  }

  // id で引く (テナント境界を跨がない)
  async findById(tenantId: string, id: string): Promise<UserRecord | null> {
    // 複合一意 (tenantId, id) で検索する
    return this.db.user.findUnique({ where: { tenantId_id: { tenantId, id } } });
  }

  // 作成 (メール重複は DuplicateError)
  async create(input: CreateUserInput): Promise<UserRecord> {
    // 挿入し、一意制約違反なら翻訳する
    try {
      return await this.db.user.create({ data: input });
    } catch (error) {
      rethrowDuplicate(error, 'email');
    }
  }

  // 役割変更 (見つからなければ null)
  async updateRole(tenantId: string, id: string, role: Role): Promise<UserRecord | null> {
    // 存在確認 (テナント境界内)
    const existing = await this.findById(tenantId, id);
    if (!existing) return null;
    // 役割を更新する
    return this.db.user.update({ where: { tenantId_id: { tenantId, id } }, data: { role } });
  }

  // 無効化 (見つからなければ null。既に無効なら日時はそのまま)
  async disable(tenantId: string, id: string): Promise<UserRecord | null> {
    // 存在確認 (テナント境界内)
    const existing = await this.findById(tenantId, id);
    if (!existing) return null;
    // 既に無効ならそのまま返す
    if (existing.disabledAt !== null) return existing;
    // 無効化日時を入れる
    return this.db.user.update({
      where: { tenantId_id: { tenantId, id } },
      data: { disabledAt: new Date() },
    });
  }

  // 有効な admin の人数
  async countActiveAdmins(tenantId: string): Promise<number> {
    // テナント内の有効な admin を数える
    return this.db.user.count({ where: { tenantId, role: Role.admin, disabledAt: null } });
  }
}

// ユーザートークン Port の prisma 実装
class PrismaUserTokens implements UserTokensPort {
  // クライアントを受け取る
  constructor(private readonly db: PrismaClient) {}

  // 発行 (発行先が同テナントに無ければ null)
  async create(input: CreateUserTokenInput): Promise<UserTokenRecord | null> {
    // 挿入する。複合 FK (tenantId, userId) が「別テナントのユーザー」を拒否するので null に翻訳する
    try {
      return await this.db.userToken.create({ data: input });
    } catch (error) {
      // 外部キー違反 = 発行先が同テナントに居ない
      if (isPrismaError(error, FOREIGN_KEY_VIOLATION)) return null;
      throw error;
    }
  }

  // ハッシュで引く (認証経路。発行先ユーザーも同時に取る)
  async findByHash(tokenHash: string): Promise<UserTokenLookup | null> {
    // 一意なハッシュで検索し、ユーザーを同時に読む (N+1 を避ける)
    const row = await this.db.userToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    // 無ければ null
    if (!row) return null;
    // ユーザー部分を分離して返す
    const { user, ...token } = row;
    return { token, user };
  }

  // あるユーザーのトークン一覧
  async list(tenantId: string, userId: string, query: PageQuery): Promise<Page<UserTokenRecord>> {
    // テナント + ユーザーで絞る
    const rows = await this.db.userToken.findMany({
      where: { tenantId, userId },
      ...pageArgs(query),
    });
    return toPage(rows, query.limit);
  }

  // 失効 (見つからなければ null)
  async revoke(tenantId: string, userId: string, id: string): Promise<UserTokenRecord | null> {
    // 存在確認 (テナント・ユーザー境界内)
    const existing = await this.db.userToken.findFirst({ where: { id, tenantId, userId } });
    if (!existing) return null;
    // 既に失効済みならそのまま
    if (existing.revokedAt !== null) return existing;
    // 失効日時を入れる
    return this.db.userToken.update({ where: { id }, data: { revokedAt: new Date() } });
  }
}

// エージェント Port の prisma 実装
class PrismaAgents implements AgentsPort {
  // クライアントを受け取る
  constructor(private readonly db: PrismaClient) {}

  // 一覧 (テナント + 状態で絞る)
  async list(tenantId: string, query: PageQuery, filter?: AgentFilter): Promise<Page<AgentRecord>> {
    // 状態の指定があれば where に足す
    const rows = await this.db.agent.findMany({
      where: { tenantId, ...(filter?.status !== undefined ? { status: filter.status } : {}) },
      ...pageArgs(query),
    });
    return toPage(rows, query.limit);
  }

  // id で引く (テナント境界を跨がない)
  async findById(tenantId: string, id: string): Promise<AgentRecord | null> {
    // 複合一意 (tenantId, id) で検索する
    return this.db.agent.findUnique({ where: { tenantId_id: { tenantId, id } } });
  }

  // 作成 (名前重複は DuplicateError)
  async create(input: CreateAgentInput): Promise<AgentRecord> {
    // 挿入し、一意制約違反なら翻訳する
    try {
      return await this.db.agent.create({ data: input });
    } catch (error) {
      rethrowDuplicate(error, 'name');
    }
  }

  // 更新 (undefined は変更しない)
  async update(tenantId: string, id: string, patch: UpdateAgentInput): Promise<AgentRecord | null> {
    // 存在確認 (テナント境界内)
    const existing = await this.findById(tenantId, id);
    if (!existing) return null;
    // 指定されたプロパティだけ更新し、名前重複は翻訳する
    try {
      return await this.db.agent.update({ where: { tenantId_id: { tenantId, id } }, data: patch });
    } catch (error) {
      rethrowDuplicate(error, 'name');
    }
  }

  // 状態変更
  async setStatus(tenantId: string, id: string, status: AgentStatus): Promise<AgentRecord | null> {
    // 存在確認 (テナント境界内)
    const existing = await this.findById(tenantId, id);
    if (!existing) return null;
    // 状態を更新する
    return this.db.agent.update({ where: { tenantId_id: { tenantId, id } }, data: { status } });
  }

  // 削除 (履歴があれば Restrict FK が拒否する → 'restricted')
  async delete(tenantId: string, id: string): Promise<DeleteAgentResult> {
    // テナント条件付きで削除する (0 件なら他テナントか存在しない)
    try {
      const result = await this.db.agent.deleteMany({ where: { id, tenantId } });
      return result.count === 0 ? 'not_found' : 'deleted';
    } catch (error) {
      // 外部キー違反 = UsageEvent / EvaluationRun / Incident の履歴がある
      if (isPrismaError(error, FOREIGN_KEY_VIOLATION)) return 'restricted';
      throw error;
    }
  }
}

// API キー Port の prisma 実装
class PrismaApiKeys implements ApiKeysPort {
  // クライアントを受け取る
  constructor(private readonly db: PrismaClient) {}

  // 一覧 (テナントで絞る。失効済みも含む)
  async list(tenantId: string, query: PageQuery): Promise<Page<ApiKeyRecord>> {
    // テナント条件 + ページ引数
    const rows = await this.db.apiKey.findMany({ where: { tenantId }, ...pageArgs(query) });
    return toPage(rows, query.limit);
  }

  // id で引く (テナント境界を跨がない)
  async findById(tenantId: string, id: string): Promise<ApiKeyRecord | null> {
    // テナント条件付きで検索する
    return this.db.apiKey.findFirst({ where: { id, tenantId } });
  }

  // 発行 (agentId が同テナントに無ければ null)
  async create(input: CreateApiKeyInput): Promise<ApiKeyRecord | null> {
    // 挿入する。複合 FK (tenantId, agentId) が「別テナントのエージェント」を拒否するので null に翻訳する
    try {
      return await this.db.apiKey.create({ data: input });
    } catch (error) {
      // 外部キー違反 = エージェントが同テナントに居ない
      if (isPrismaError(error, FOREIGN_KEY_VIOLATION)) return null;
      throw error;
    }
  }

  // 失効 (見つからなければ null)
  async revoke(tenantId: string, id: string): Promise<ApiKeyRecord | null> {
    // 存在確認 (テナント境界内)
    const existing = await this.findById(tenantId, id);
    if (!existing) return null;
    // 既に失効済みならそのまま
    if (existing.revokedAt !== null) return existing;
    // 失効日時を入れる
    return this.db.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
  }
}

// prisma アダプタ一式を組み立てる (Composition Root と契約テストが呼ぶ)
export function createPrismaRepos(db: PrismaClient): Repositories {
  // 各 Port を同じクライアントで結線して返す
  return {
    tenants: new PrismaTenants(db),
    users: new PrismaUsers(db),
    userTokens: new PrismaUserTokens(db),
    agents: new PrismaAgents(db),
    apiKeys: new PrismaApiKeys(db),
  };
}
