// prisma アダプタ: Port を Prisma (PostgreSQL) で実装する (本番用)。
// Prisma を直接 import してよいのはこのディレクトリと結線箇所 (src/lib/prisma*.ts) だけ (ESLint が強制する)。
// テナント絞り込みは全クエリの where に必ず入れる (ADR-0002)
import { DuplicateError } from '@/data/errors';
import { toPage } from '@/data/page';
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
  UserMutationResult,
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
// 更新・削除対象の行が無い (update の where に一致する行が無い)
const RECORD_NOT_FOUND = 'P2025';

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

// カーソルが「この一覧の絞り込み条件の中」に実在するかを確かめる。Prisma の cursor は id だけで行を解決し
// where と AND しないため、他テナント・絞り込み外の id を渡すと (a) 空ではなく正規の先頭行を 1 件飛ばしたページが
// 返り、(b) 空/非空の差で他テナントの id の存在が分かる。memory アダプタ (絞り込み後に探すので空) と同じにする
async function cursorInScope(
  query: PageQuery,
  find: (id: string) => Promise<{ id: string } | null>,
): Promise<boolean> {
  // カーソル無しなら常に範囲内
  if (query.cursor === undefined) return true;
  // 絞り込み条件付きで引けたときだけ範囲内
  return (await find(query.cursor)) !== null;
}

// P2025 (対象行が無い) を null に翻訳して update を実行する (事前の存在確認を省き、その間に消える窓も無くす)
async function updateOrNull<T>(update: () => Promise<T>): Promise<T | null> {
  // 更新を試みる
  try {
    return await update();
  } catch (error) {
    // 対象が無ければ null (テナント境界外も同じ)
    if (isPrismaError(error, RECORD_NOT_FOUND)) return null;
    throw error;
  }
}

// トランザクション内外の両方で使えるクライアント型
type Db = PrismaClient | Prisma.TransactionClient;

// テナント Port の prisma 実装
class PrismaTenants implements TenantsPort {
  // クライアントを受け取る
  constructor(private readonly db: PrismaClient) {}

  // 全テナントを一覧する (プラットフォーム管理者専用。テナント境界の外側)
  async list(query: PageQuery): Promise<Page<TenantRecord>> {
    // カーソルが実在しなければ空ページ
    const inScope = await cursorInScope(query, (id) =>
      this.db.tenant.findUnique({ where: { id }, select: { id: true } }),
    );
    if (!inScope) return { items: [] };
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
    // カーソルが自テナントに実在しなければ空ページ
    const inScope = await cursorInScope(query, (id) =>
      this.db.user.findUnique({ where: { tenantId_id: { tenantId, id } }, select: { id: true } }),
    );
    if (!inScope) return { items: [] };
    // テナント条件 + ページ引数
    const rows = await this.db.user.findMany({ where: { tenantId }, ...pageArgs(query) });
    return toPage(rows, query.limit);
  }

  // id で引く (テナント境界を跨がない)
  async findById(tenantId: string, id: string): Promise<UserRecord | null> {
    // 複合一意 (tenantId, id) で検索する
    return this.db.user.findUnique({ where: { tenantId_id: { tenantId, id } } });
  }

  // メールで引く (複合一意 (tenantId, email))
  async findByEmail(tenantId: string, email: string): Promise<UserRecord | null> {
    // 複合一意で検索する
    return this.db.user.findUnique({ where: { tenantId_email: { tenantId, email } } });
  }

  // 「最後の有効な admin」判定つきの更新を、テナント行の行ロックで直列化して行う。
  // count → update を素朴に並べると、2 人の admin が互いを同時に降格/無効化したとき両方の count が 2 を返して
  // admin が 0 人になる。同じテナントの要求を FOR UPDATE で 1 本ずつ通し、判定と更新を同じトランザクションに置く
  private async mutateGuardingLastAdmin(
    tenantId: string,
    id: string,
    // 対象を admin から外す操作か (true なら「最後の admin」判定を行う)
    removesAdmin: (target: UserRecord) => boolean,
    // 実際の更新 (トランザクション内で呼ぶ)
    apply: (tx: Db, target: UserRecord) => Promise<UserRecord>,
  ): Promise<UserMutationResult> {
    // 1 トランザクションで判定と更新を行う
    return this.db.$transaction(async (tx: Db): Promise<UserMutationResult> => {
      // テナント行をロックし、同じテナントへの同種の要求を直列化する (存在しないテナントなら対象も無い)
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
      if (locked.length === 0) return { status: 'not_found' };
      // 対象 (テナント境界内)
      const target = await tx.user.findUnique({ where: { tenantId_id: { tenantId, id } } });
      if (!target) return { status: 'not_found' };
      // 対象が有効な admin で、操作で admin から外れるなら、他に有効な admin が居ることを要求する
      if (target.role === Role.admin && target.disabledAt === null && removesAdmin(target)) {
        // 対象以外の有効な admin の人数
        const others = await tx.user.count({
          where: { tenantId, role: Role.admin, disabledAt: null, id: { not: id } },
        });
        if (others === 0) return { status: 'last_admin' };
      }
      // 更新する
      return { status: 'ok', user: await apply(tx, target) };
    });
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

  // 役割変更 (最後の有効な admin を admin 以外へ変える要求は 'last_admin')
  async updateRole(tenantId: string, id: string, role: Role): Promise<UserMutationResult> {
    // admin 以外へ変えるときだけ「最後の admin」判定を行う
    return this.mutateGuardingLastAdmin(
      tenantId,
      id,
      () => role !== Role.admin,
      (tx) => tx.user.update({ where: { tenantId_id: { tenantId, id } }, data: { role } }),
    );
  }

  // 無効化 (最後の有効な admin は 'last_admin'。既に無効なら日時はそのまま)
  async disable(tenantId: string, id: string): Promise<UserMutationResult> {
    // 無効化は常に admin から外す操作
    return this.mutateGuardingLastAdmin(
      tenantId,
      id,
      () => true,
      // 既に無効なら更新せずそのまま返す (最初の日時を保つ)
      (tx, target) =>
        target.disabledAt !== null
          ? Promise.resolve(target)
          : tx.user.update({
              where: { tenantId_id: { tenantId, id } },
              data: { disabledAt: new Date() },
            }),
    );
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
    // カーソルがこのユーザーのトークンとして実在しなければ空ページ
    const inScope = await cursorInScope(query, (id) =>
      this.db.userToken.findFirst({ where: { id, tenantId, userId }, select: { id: true } }),
    );
    if (!inScope) return { items: [] };
    // テナント + ユーザーで絞る
    const rows = await this.db.userToken.findMany({
      where: { tenantId, userId },
      ...pageArgs(query),
    });
    return toPage(rows, query.limit);
  }

  // 失効 (見つからなければ null。既に失効済みなら日時はそのまま)
  async revoke(tenantId: string, userId: string, id: string): Promise<UserTokenRecord | null> {
    // まだ有効な行だけに失効日時を入れる (条件付き更新なので、存在確認との間の窓が無い)
    await this.db.userToken.updateMany({
      where: { id, tenantId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // 現在の行を返す (境界外なら null)
    return this.db.userToken.findFirst({ where: { id, tenantId, userId } });
  }
}

// エージェント Port の prisma 実装
class PrismaAgents implements AgentsPort {
  // クライアントを受け取る
  constructor(private readonly db: PrismaClient) {}

  // 一覧 (テナント + 状態で絞る)
  async list(tenantId: string, query: PageQuery, filter?: AgentFilter): Promise<Page<AgentRecord>> {
    // 絞り込み条件 (状態の指定があれば足す)
    const where = { tenantId, ...(filter?.status !== undefined ? { status: filter.status } : {}) };
    // カーソルが絞り込みの中に実在しなければ空ページ
    const inScope = await cursorInScope(query, (id) =>
      this.db.agent.findFirst({ where: { id, ...where }, select: { id: true } }),
    );
    if (!inScope) return { items: [] };
    // 1 件多く取って Page へ整形する
    const rows = await this.db.agent.findMany({ where, ...pageArgs(query) });
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

  // 更新 (undefined は変更しない。対象が無ければ null、名前重複は DuplicateError)
  async update(tenantId: string, id: string, patch: UpdateAgentInput): Promise<AgentRecord | null> {
    // 複合一意 (tenantId, id) で 1 クエリで更新し、無ければ null・重複は翻訳する
    try {
      return await updateOrNull(() =>
        this.db.agent.update({ where: { tenantId_id: { tenantId, id } }, data: patch }),
      );
    } catch (error) {
      rethrowDuplicate(error, 'name');
    }
  }

  // 状態変更 (対象が無ければ null)
  async setStatus(tenantId: string, id: string, status: AgentStatus): Promise<AgentRecord | null> {
    // 複合一意 (tenantId, id) で 1 クエリで更新する
    return updateOrNull(() =>
      this.db.agent.update({ where: { tenantId_id: { tenantId, id } }, data: { status } }),
    );
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
    // カーソルが自テナントに実在しなければ空ページ
    const inScope = await cursorInScope(query, (id) =>
      this.db.apiKey.findFirst({ where: { id, tenantId }, select: { id: true } }),
    );
    if (!inScope) return { items: [] };
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

  // 失効 (見つからなければ null。既に失効済みなら日時はそのまま)
  async revoke(tenantId: string, id: string): Promise<ApiKeyRecord | null> {
    // まだ有効な行だけに失効日時を入れる (条件付き更新なので、存在確認との間の窓が無い)
    await this.db.apiKey.updateMany({
      where: { id, tenantId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // 現在の行を返す (境界外なら null)
    return this.findById(tenantId, id);
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
