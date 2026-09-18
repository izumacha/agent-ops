// prisma アダプタ: Port を Prisma (PostgreSQL) で実装する (本番用)。
// Prisma を直接 import してよいのはこのディレクトリと結線箇所 (src/lib/prisma*.ts) だけ (ESLint が強制する)。
// テナント絞り込みは全クエリの where に必ず入れる (ADR-0002)
import { DuplicateError } from '@/data/errors';
import { fetchCount, toPage, type CursorKey } from '@/data/page';
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
  UserTokenCreateResult,
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

// 失効の共通形 (UserToken / ApiKey): まだ有効な行だけに失効日時を入れ (条件付き更新なので存在確認との間の窓が無い)、
// 現在の行を返す (境界外なら null。既に失効済みなら日時はそのまま)
async function revokeThenReload<T>(
  revoke: (revokedAt: Date) => Promise<unknown>,
  reload: () => Promise<T | null>,
): Promise<T | null> {
  // 条件付きで失効日時を入れる
  await revoke(new Date());
  // 現在の行を読み直す
  return reload();
}

// 一意制約違反なら DuplicateError へ翻訳して投げ、それ以外はそのまま投げ直す
function rethrowDuplicate(error: unknown, field: string): never {
  // 一意制約違反はデータ層の型へ翻訳する
  if (isPrismaError(error, UNIQUE_VIOLATION)) throw new DuplicateError(field);
  // それ以外は握り潰さず投げ直す
  throw error;
}

// カーソルより後ろの行だけに絞る where 条件 (キーセット: createdAt が後、または同時刻で id が後)。
// Prisma の `cursor` 引数は行 id で解決し where と AND しないため使わない (他テナントの id で先頭行が飛ぶ・
// 存在が漏れる・行が消えると続きが取れない)。位置の比較なら 3 つとも起きない
function afterCursorWhere(key: CursorKey) {
  // (createdAt, id) > (key.createdAt, key.id)
  return {
    OR: [{ createdAt: { gt: key.createdAt } }, { createdAt: key.createdAt, id: { gt: key.id } }],
  };
}

// 一覧の共通引数: 絞り込み条件にカーソル条件を AND し、createdAt → id の安定順で 1 件多く取る
function pageArgs<W>(query: PageQuery, where: W) {
  // カーソルがあれば位置の条件を足す
  const scoped =
    query.cursor !== undefined ? { AND: [where, afterCursorWhere(query.cursor)] } : where;
  // where・並び順・件数をまとめて返す
  return {
    where: scoped,
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    take: fetchCount(query),
  };
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

// 対象ユーザーを掴めたか (掴めたなら以後 disabledAt はコミットまで変わらない)
type LockedUser = { status: 'ok' } | { status: 'not_found' } | { status: 'disabled' };

/**
 * 対象ユーザーの行を FOR NO KEY UPDATE でロックし、テナント境界と無効化済みかを見る。
 * disable の UPDATE は同じロックを取るので、ここで見た disabledAt はトランザクションのコミットまで変わらない
 * (逆順なら無効化のコミット後に最新の行を読み直す)。子テーブル INSERT の FK 検査 (FOR KEY SHARE) とは衝突しない。
 * 生 SQL なので写しを持たない — ロック句を片方だけ落とす変更は型検査もテストも素通りするため
 */
async function lockActiveUser(tx: Db, tenantId: string, id: string): Promise<LockedUser> {
  // 行をロックして無効化日時だけ取る
  const locked = await tx.$queryRaw<
    { disabledAt: Date | null }[]
  >`SELECT "disabledAt" FROM "User" WHERE "tenantId" = ${tenantId} AND id = ${id} FOR NO KEY UPDATE`;
  // 同テナントに居ない
  if (locked.length === 0) return { status: 'not_found' };
  // 無効化済み
  if (locked[0].disabledAt !== null) return { status: 'disabled' };
  // 掴めた
  return { status: 'ok' };
}

// テナント Port の prisma 実装
class PrismaTenants implements TenantsPort {
  // クライアントを受け取る
  constructor(private readonly db: PrismaClient) {}

  // 全テナントを一覧する (プラットフォーム管理者専用。テナント境界の外側)
  async list(query: PageQuery): Promise<Page<TenantRecord>> {
    // 1 件多く取って Page へ整形する (テナント境界の外側なので絞り込み条件は空)
    const rows = await this.db.tenant.findMany(pageArgs(query, {}));
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
    // テナント条件 + ページ引数で 1 件多く取る
    const rows = await this.db.user.findMany(pageArgs(query, { tenantId }));
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
    // 実際の更新 (トランザクション内で呼ぶ)。呼び出し側はいずれも「対象を admin から外す」操作
    // (admin への昇格は「最後の admin」判定が要らないので updateRole がこの関数を通さない)
    apply: (tx: Db, target: UserRecord) => Promise<UserRecord>,
    // 無効化済みユーザーを 'disabled' で拒否するか (役割変更は拒否、無効化は冪等にしたいので拒否しない)
    rejectDisabled = false,
  ): Promise<UserMutationResult> {
    // 1 トランザクションで判定と更新を行う
    return this.db.$transaction(async (tx: Db): Promise<UserMutationResult> => {
      // テナント行をロックし、同じテナントへの同種の要求を直列化する (存在しないテナントなら対象も無い)。
      // FOR NO KEY UPDATE にするのは、子テーブルの INSERT が親行に取る FK 検査のロック (FOR KEY SHARE) と衝突させないため
      // (FOR UPDATE だと役割変更中はテナント内の全書き込みが待たされる。NO KEY UPDATE 同士は衝突するので相互排他は保たれる)
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR NO KEY UPDATE`;
      if (locked.length === 0) return { status: 'not_found' };
      // 対象 (テナント境界内)
      const target = await tx.user.findUnique({ where: { tenantId_id: { tenantId, id } } });
      if (!target) return { status: 'not_found' };
      // 無効化済みユーザーの役割変更は拒否する (無効化そのものは冪等にしたいので、判定は呼び出し側が渡す)
      if (rejectDisabled && target.disabledAt !== null) return { status: 'disabled' };
      // 対象が有効な admin なら (この操作で admin から外れるので)、他に有効な admin が居ることを要求する
      if (target.role === Role.admin && target.disabledAt === null) {
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
    // 更新そのもの (複合一意 (tenantId, id) で 1 回)
    const apply = (db: Db) =>
      db.user.update({ where: { tenantId_id: { tenantId, id } }, data: { role } });
    // admin への昇格は admin を減らさないので「最後の admin」判定は要らない。ただし無効化済みかどうかは見る
    // (認証できない admin を作らない)。無効化との競合を防ぐため、対象行をロックしてから判定する
    if (role === Role.admin) {
      return this.db.$transaction(async (tx: Db): Promise<UserMutationResult> => {
        // 対象行を掴む (他テナント・無効化済みはここで決まる)
        const locked = await lockActiveUser(tx, tenantId, id);
        if (locked.status !== 'ok') return locked;
        // 更新する
        return { status: 'ok', user: await apply(tx) };
      });
    }
    // admin 以外へ変えるときは「最後の admin」判定と同じトランザクションで更新する
    return this.mutateGuardingLastAdmin(tenantId, id, apply, true);
  }

  // 無効化 (最後の有効な admin は 'last_admin'。既に無効なら日時はそのまま)
  async disable(tenantId: string, id: string): Promise<UserMutationResult> {
    // 無効化は常に admin から外す操作
    return this.mutateGuardingLastAdmin(
      tenantId,
      id,
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

  // 発行 (判定と挿入を 1 トランザクションで行う)
  async create(input: CreateUserTokenInput): Promise<UserTokenCreateResult> {
    // 無効化との競合を防ぐため、発行先ユーザーの行をロックしてから判定する
    return this.db.$transaction(async (tx: Db): Promise<UserTokenCreateResult> => {
      // 発行先の行を掴む (他テナント・無効化済みはここで決まる)
      const locked = await lockActiveUser(tx, input.tenantId, input.userId);
      if (locked.status !== 'ok') return locked;
      // 挿入する (複合 FK (tenantId, userId) は上の検索で満たしている)
      return { status: 'ok', token: await tx.userToken.create({ data: input }) };
    });
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
    // テナント + ユーザーで絞って 1 件多く取る
    const rows = await this.db.userToken.findMany(pageArgs(query, { tenantId, userId }));
    return toPage(rows, query.limit);
  }

  // 失効 (見つからなければ null。既に失効済みなら日時はそのまま)
  async revoke(tenantId: string, userId: string, id: string): Promise<UserTokenRecord | null> {
    // 共通の失効の形 (条件付き更新 → 読み直し)
    return revokeThenReload(
      (revokedAt) =>
        this.db.userToken.updateMany({
          where: { id, tenantId, userId, revokedAt: null },
          data: { revokedAt },
        }),
      () => this.db.userToken.findFirst({ where: { id, tenantId, userId } }),
    );
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
    // 1 件多く取って Page へ整形する
    const rows = await this.db.agent.findMany(pageArgs(query, where));
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
    // テナント条件 + ページ引数で 1 件多く取る
    const rows = await this.db.apiKey.findMany(pageArgs(query, { tenantId }));
    return toPage(rows, query.limit);
  }

  // id で引く (テナント境界を跨がない)
  async findById(tenantId: string, id: string): Promise<ApiKeyRecord | null> {
    // テナント条件付きで検索する
    return this.db.apiKey.findFirst({ where: { id, tenantId } });
  }

  // 発行 (agentId が同テナントに無ければ null)
  async create(input: CreateApiKeyInput): Promise<ApiKeyRecord | null> {
    // テナント共通キーなら紐づけ先の確認は要らない
    if (input.agentId === null) return this.db.apiKey.create({ data: input });
    // 紐づけ先の確認と挿入を 1 トランザクションで行う (ユーザートークンの発行と同じ形)。
    // FK 違反 (P2003) の翻訳に頼らない — Prisma 7 のドライバアダプタ経由のエラーは「どの制約か」を安定した形で
    // 持たず、どの FK でも同じ原因に翻訳すると Tenant 側 FK の違反まで「エージェントが見つからない」になる
    return this.db.$transaction(async (tx: Db): Promise<ApiKeyRecord | null> => {
      // 紐づけ先のエージェント行 (テナント境界内) を FOR KEY SHARE で押さえる (削除だけを待たせ、状態変更や
      // 他のキー発行は妨げない)。存在すれば挿入は複合 FK (tenantId, agentId) を必ず満たす
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "Agent" WHERE "tenantId" = ${input.tenantId} AND id = ${input.agentId} FOR KEY SHARE`;
      // 同テナントに居なければ発行しない
      if (locked.length === 0) return null;
      // 挿入する
      return tx.apiKey.create({ data: input });
    });
  }

  // 失効 (見つからなければ null。既に失効済みなら日時はそのまま)
  async revoke(tenantId: string, id: string): Promise<ApiKeyRecord | null> {
    // 共通の失効の形 (条件付き更新 → 読み直し)
    return revokeThenReload(
      (revokedAt) =>
        this.db.apiKey.updateMany({
          where: { id, tenantId, revokedAt: null },
          data: { revokedAt },
        }),
      () => this.findById(tenantId, id),
    );
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
