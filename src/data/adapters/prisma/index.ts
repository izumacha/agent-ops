// prisma アダプタ: Port を Prisma (PostgreSQL) で実装する (本番用)。
// Prisma を直接 import してよいのはこのディレクトリと結線箇所 (src/lib/prisma*.ts) だけ (ESLint が強制する)。
// テナント絞り込みは全クエリの where に必ず入れる (ADR-0002)
import { randomUUID } from 'node:crypto';
import { FIRST_AUDIT_SEQ, nextAuditSeq } from '@/domain/audit/chain';
import { USAGE_ERROR_STATUS_FLOOR } from '@/domain/guardrail/rule';
import { DuplicateError } from '@/data/errors';
import { fetchCount, toPage, type CursorKey } from '@/data/page';
import { toSafeCount } from '@/data/safe-count';
import type {
  ActiveRuleQuery,
  AgentFilter,
  AgentRecord,
  AgentLimits,
  AgentsPort,
  ApiKeyRecord,
  ApiKeysPort,
  AppendAuditLogInput,
  BillingEventsPort,
  AuditHashInput,
  AuditLogRecord,
  AuditLogsPort,
  CreateGuardrailRuleInput,
  CreateGuardrailRuleResult,
  DeleteGuardrailRuleResult,
  GuardrailRuleLimits,
  GuardrailRuleRecord,
  GuardrailRulesPort,
  IncidentFilter,
  IncidentRecord,
  IncidentsPort,
  RaiseIncidentInput,
  RaisedIncident,
  ResolveIncidentResult,
  SetGuardrailRuleEnabledResult,
  UsageWindowQuery,
  UsageWindowTotal,
  CreateAgentInput,
  CreateApiKeyInput,
  CreateEvaluationRunInput,
  CreateEvaluationSetInput,
  CreateTenantInput,
  CreateAgentResult,
  CreateTenantResult,
  RecordBillingEventInput,
  BillingPlanApplication,
  RecordBillingEventResult,
  UpdateTenantPlanInput,
  CreateUserInput,
  CreateUserTokenInput,
  DailyUsageQuery,
  DailyUsageTotal,
  DeleteAgentResult,
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

/**
 * 一意な列が**複数ある**更新で、実際に衝突した列を選んで翻訳する。
 *
 * 列名は `DuplicateError.field` に入り 422 の `issues.path` へ出るので、固定の名前を渡すと
 * 「サブスクリプション ID が衝突したのに顧客 ID のせいだと答える」形になる。memory アダプタは
 * 実際に衝突した列を返すので、固定にすると**両アダプタの答えが割れる**（ADR-0006 の死角）。
 *
 * **どこに列名が入るかはドライバの形に依る。** Prisma 7 のドライバアダプタ経由では `meta.target`
 * が無く、違反した**索引の名前**が `meta.driverAdapterError.cause.constraint.index` に入る
 * （実測: `Tenant_billingSubscriptionId_key`）。将来どちらの形になっても拾えるよう両方を見て、
 * 候補の列名が「索引名の `_` 区切りの一部」として現れるかで判定する。
 * 読めなかったときは先頭の候補へ倒す（名前を落とすと利用者がどの項目を直せばよいか分からない）。
 * 正しい列を選べていることは `tests/data/billing.contract.prisma.test.ts` が実 DB で固定する。
 */
function rethrowDuplicateAmong(error: unknown, candidates: readonly string[]): never {
  // 一意制約違反でなければそのまま投げ直す
  if (!isPrismaError(error, UNIQUE_VIOLATION)) throw error;
  // 候補のうち実際に違反したものを選ぶ（読めなければ先頭の候補）
  throw new DuplicateError(violatedUniqueCandidate(error, candidates) ?? candidates[0]);
}

/**
 * 一意制約違反のエラーから「候補のうちどれが違反したか」を読む（読めなければ `undefined`）。
 *
 * **`rethrowDuplicateAmong` と共有する**（§6 DRY）— 読み方を書き写すと、ドライバの形が変わった
 * ときに片方だけが直り、もう片方が古い読み方のまま静かに「読めなかった」へ倒れる。
 * 呼び出し側は「どの制約で落ちたか」で振る舞いを分けるので（2 通目の受信 / 連携の衝突）、
 * **読めたときだけ**名前を返して判断は渡す。
 */
function violatedUniqueCandidate(
  error: unknown,
  candidates: readonly string[],
): string | undefined {
  // エラーの付随情報（形はドライバに依るので unknown のまま辿る）
  const meta: unknown = (error as Prisma.PrismaClientKnownRequestError).meta;
  // 列名が直接入る形（`meta.target`）を文字列の配列へ正規化する
  const target = readUnknownPath(meta, ['target']);
  const targets = Array.isArray(target) ? target.map(String) : [];
  // **文字列 1 つの `target` は列名ではなく制約の名前が入ることがある**ので、索引名と同じ扱いにする
  // （完全一致だけを見ていると `BillingEvent_provider_eventId_key` のような値で常に「読めなかった」へ倒れる）
  const named = [
    typeof target === 'string' ? target : '',
    // 索引の名前が入る形（ドライバアダプタ経由）
    (() => {
      const index = readUnknownPath(meta, ['driverAdapterError', 'cause', 'constraint', 'index']);
      return typeof index === 'string' ? index : '';
    })(),
  ]
    // 名前を `_` で囲んでおくと、端の列名も「区切りに挟まれた一部」として同じ規則で探せる
    .map((name) => (name === '' ? '' : `_${name}_`));
  // 候補のうち実際に違反したものを探す
  return candidates.find(
    (candidate) =>
      targets.includes(candidate) || named.some((name) => name.includes(`_${candidate}_`)),
  );
}

// unknown のまま入れ子のプロパティを辿る（形がドライバ依存なので型を主張しない。
// 途中が無い・オブジェクトでないときは undefined を返す = 読めなかった扱い）
function readUnknownPath(value: unknown, path: readonly string[]): unknown {
  // 現在位置（最初は受け取った値そのもの）
  let current: unknown = value;
  // キーを 1 つずつ降りる
  for (const key of path) {
    // オブジェクトでなければそこで読めない
    if (typeof current !== 'object' || current === null) return undefined;
    // 自身のキーとしてあるものだけを信用する（プロトタイプ由来の名前を拾わない）
    if (!Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  // 辿り切った値
  return current;
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
async function lockActiveUser(
  // トランザクション内で呼ぶこと。$transaction の外で呼ぶと文の終わりでロックが解け、無効化との競合を防げない。
  // 型はその前提を書き残すためのもので、強制はできない (TransactionClient は PrismaClient から一部を
  // 取り除いた上位の型なので、通常のクライアントもそのまま渡せてしまう)
  tx: Prisma.TransactionClient,
  tenantId: string,
  id: string,
): Promise<LockedUser> {
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

// ── DB へ渡してよい項目だけを書き出す writer 群 ─────────────────────────────
// Port の入力を `data:` へ丸ごと渡さず、ここで 1 項目ずつ写してから渡す。理由は 2 つある。
// (1) 丸ごと渡すと、入力の型に項目が増えたとき (契約と Zod を一緒に直すのが自然な直し方) それがそのまま
//     DB へ届く。実測では更新経路で「execute 権限しか要らない更新で停止できる (stop 権限の迂回)」
//     「行が別テナントへ移る」まで到達した。型では止まらない — 変数を渡すと TypeScript の
//     「余分なプロパティ」の検査が働かないため。
// (2) 逆に手で並べると今度は**足し忘れ**が起きる (落ちた項目は成功応答のまま黙って無視される)。
//     そこで戻り値の型を Required<入力型> のマップ型にし、項目が増減したら型検査が落ちるようにする。
// 作成・更新のどちらも同じ規約にそろえる (片方だけ例外にすると、どちらが正しい書き方かがレビューで揺れる)。

// ユーザー作成
function userCreateData(input: CreateUserInput): {
  [K in keyof Required<CreateUserInput>]: CreateUserInput[K];
} {
  // 許した項目だけを写す
  return { tenantId: input.tenantId, email: input.email, name: input.name, role: input.role };
}

// ログイントークン発行
function userTokenCreateData(input: CreateUserTokenInput): {
  [K in keyof Required<CreateUserTokenInput>]: CreateUserTokenInput[K];
} {
  // 許した項目だけを写す
  return {
    tenantId: input.tenantId,
    userId: input.userId,
    prefix: input.prefix,
    tokenHash: input.tokenHash,
    name: input.name,
    expiresAt: input.expiresAt,
  };
}

// エージェント作成
function agentCreateData(input: CreateAgentInput): {
  [K in keyof Required<CreateAgentInput>]: CreateAgentInput[K];
} {
  // 許した項目だけを写す (状態 status は既定値から始めるので受け取らない)
  return {
    tenantId: input.tenantId,
    name: input.name,
    description: input.description,
    provider: input.provider,
    model: input.model,
    budgetMicroUsd: input.budgetMicroUsd,
  };
}

// エージェント更新
function agentUpdateData(patch: UpdateAgentInput): {
  [K in keyof Required<UpdateAgentInput>]: UpdateAgentInput[K];
} {
  // 許した項目だけを写す (undefined の項目は Prisma が「変更しない」として扱う)
  return {
    name: patch.name,
    description: patch.description,
    model: patch.model,
    budgetMicroUsd: patch.budgetMicroUsd,
  };
}

// API キー発行
function apiKeyCreateData(input: CreateApiKeyInput): {
  [K in keyof Required<CreateApiKeyInput>]: CreateApiKeyInput[K];
} {
  // 許した項目だけを写す (失効日時 revokedAt は発行時には入れない)
  return {
    tenantId: input.tenantId,
    agentId: input.agentId,
    prefix: input.prefix,
    keyHash: input.keyHash,
    name: input.name,
  };
}

// 利用イベントの記録
function usageEventCreateData(input: RecordUsageEventInput): {
  [K in keyof Required<RecordUsageEventInput>]: RecordUsageEventInput[K];
} {
  // 許した項目だけを写す (発生日時 createdAt は DB の既定値に任せる)
  return {
    tenantId: input.tenantId,
    agentId: input.agentId,
    provider: input.provider,
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    costMicroUsd: input.costMicroUsd,
    latencyMs: input.latencyMs,
    statusCode: input.statusCode,
  };
}

/**
 * プラン更新の `data`（`tenants.updatePlan` と受信 Webhook の原子的な反映が共有する）。
 *
 * **`billing*` を渡されたときだけ書く** — 素の `input` を data へ渡すと、省略した項目が
 * undefined として入って「変更しない」ではなく「null で上書き」に化ける writer がありうる。
 */
function tenantPlanData(input: UpdateTenantPlanInput) {
  // プランは必ず書き、課金事業者側の id は指定されたときだけ載せる
  return {
    plan: input.plan,
    ...(input.billingCustomerId !== undefined
      ? { billingCustomerId: input.billingCustomerId }
      : {}),
    ...(input.billingSubscriptionId !== undefined
      ? { billingSubscriptionId: input.billingSubscriptionId }
      : {}),
  };
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

  // 課金事業者側の顧客 ID で引く (一意索引があるので 1 件以下)
  async findByBillingCustomerId(customerId: string): Promise<TenantRecord | null> {
    // 一意索引で検索する (テナント境界の外側 — Webhook が「どのテナントか」を決める唯一の経路)
    return this.db.tenant.findUnique({ where: { billingCustomerId: customerId } });
  }

  // プラン (と課金事業者側の id) を変える。対象が無ければ null
  async updatePlan(tenantId: string, input: UpdateTenantPlanInput): Promise<TenantRecord | null> {
    // 主キーで 1 クエリで更新し、無ければ null・一意制約違反は翻訳する
    try {
      return await updateOrNull(() =>
        this.db.tenant.update({ where: { id: tenantId }, data: tenantPlanData(input) }),
      );
    } catch (error) {
      // 顧客 ID / サブスクリプション ID の一意制約違反 (2 テナントが同じ契約を名乗る) を翻訳する。
      // **どちらが衝突したかは Prisma の meta から選ぶ** (memory 側と答えをそろえる)
      rethrowDuplicateAmong(error, ['billingCustomerId', 'billingSubscriptionId']);
    }
  }

  // テナント + admin + トークンを 1 トランザクションで作る
  async createWithAdmin(input: CreateTenantInput): Promise<CreateTenantResult> {
    // 途中で失敗したらすべて巻き戻す (admin のいないテナントを残さない)
    return this.db.$transaction(async (tx: Db) => {
      // テナント行
      const tenant = await tx.tenant.create({
        // プランは free から始める (切り替えは課金を入れる後の Step で足す。いまは入力で決めさせない)
        data: { name: input.name, plan: Plan.free },
      });
      // admin ユーザー行 (役割は必ず admin。ここだけ writer を通さないと、CreateUserInput に項目が増えたとき
      // 「テナント最初の admin」だけが黙って落ちる — いちばん静かに壊れて困る経路なので同じ規約にそろえる)
      const admin = await tx.user.create({
        data: userCreateData({
          tenantId: tenant.id,
          email: input.admin.email,
          name: input.admin.name,
          role: Role.admin,
        }),
      });
      // トークン行 (ブートストラップ用。上と同じ理由で writer を通す)
      const token = await tx.userToken.create({
        data: userTokenCreateData({
          tenantId: tenant.id,
          userId: admin.id,
          prefix: input.token.prefix,
          tokenHash: input.token.tokenHash,
          name: input.token.name,
          expiresAt: input.token.expiresAt,
        }),
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
  // admin が 0 人になる。同じテナントの要求を行ロックで 1 本ずつ通し、判定と更新を同じトランザクションに置く
  // (ロックの強さは FOR NO KEY UPDATE。理由は下の注記のとおりで、FOR UPDATE へ強めてはいけない)
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
      // 対象の行もロックしてから読む。役割を変える操作のうち admin への昇格 (updateRole) だけはテナント行を
      // 取らず対象の行しか掴まないので、ロック無しに読むと「読み取り → (並行する昇格のコミット) → 無条件の更新」
      // の順になり、昇格が 200 で「admin になった」と応答したのにその結果が上書きされて消える (lost update)。
      // ロックを先に取れば、降格・無効化は昇格のコミットを待ってから読み直すので、応答と最終状態が食い違わない。
      // なお「有効な admin が 0 人になる」ことは今の Port では起きない (admin を減らす操作はすべてこの関数を
      // 通ってテナント行で直列化され、昇格は増やす方向にしか効かないため)。将来ユーザー削除・テナント削除を
      // 足すとここが不変条件そのものを支えるので、ロックは外さない。
      // テナント行のロックを FOR UPDATE へ強めてはいけない (上の注記のとおり、子テーブル INSERT の
      // FK 検査が取る FOR KEY SHARE と衝突して本物のデッドロックになる)
      const lockedTarget = await lockActiveUser(tx, tenantId, id);
      // 同テナントに居ない
      if (lockedTarget.status === 'not_found') return { status: 'not_found' };
      // 無効化済みユーザーの役割変更は拒否する (無効化そのものは冪等にしたいので、判定は呼び出し側が渡す)
      if (rejectDisabled && lockedTarget.status === 'disabled') return { status: 'disabled' };
      // 対象の中身 (ロック済みなので、この読み取りはコミットまで変わらない)
      const target = await tx.user.findUnique({ where: { tenantId_id: { tenantId, id } } });
      // ロックできた行なので必ず見つかる (null を除いて型を絞るためだけの分岐)
      if (!target) return { status: 'not_found' };
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
      return await this.db.user.create({ data: userCreateData(input) });
    } catch (error) {
      rethrowDuplicate(error, 'email');
    }
  }

  // 役割変更 (最後の有効な admin を admin 以外へ変える要求は 'last_admin')
  async updateRole(tenantId: string, id: string, role: Role): Promise<UserMutationResult> {
    // 更新そのもの (複合一意 (tenantId, id) で 1 回)。
    // ここのテナント条件は**多層防御**で、テストからは観測できない — 更新にたどり着く前に必ず
    // lockActiveUser(tx, tenantId, id) が他テナントを 'not_found' で弾いているため、
    // where を id だけに落としても全テストが緑のままになる。観測できないことを理由に外さないこと
    // (弾く側を将来変えたとき、テナント境界を守る条件がこの 1 つだけになる)
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
      return {
        status: 'ok',
        token: await tx.userToken.create({ data: userTokenCreateData(input) }),
      };
    });
  }

  // ハッシュで引く (認証経路。発行先ユーザーも同時に取る)
  async findByHash(tokenHash: string): Promise<UserTokenLookup | null> {
    // 一意なハッシュで検索し、ユーザーと**テナントのプラン**を同時に読む (N+1 を避ける。
    // プランは認証のたびに要るので、別の問い合わせにすると全 API に 1 往復が増える)
    const row = await this.db.userToken.findUnique({
      where: { tokenHash },
      include: { user: true, tenant: { select: { plan: true } } },
    });
    // 無ければ null
    if (!row) return null;
    // ユーザーとテナントの部分を分離して返す (トークン行に余分な項目を混ぜない)
    const { user, tenant, ...token } = row;
    return { token, user, plan: tenant.plan };
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

  // 指定した id の名前だけをまとめて引く (1 クエリ。テナント境界を跨がない)
  async findNamesByIds(tenantId: string, ids: readonly string[]): Promise<Map<string, string>> {
    // 空なら問い合わせない (`in: []` は常に空集合なので、往復の分だけ無駄になる)
    if (ids.length === 0) return new Map();
    // 自テナントの行だけを、要求された id に絞って引く (読むのは id と名前だけ)
    const rows = await this.db.agent.findMany({
      where: { tenantId, id: { in: [...new Set(ids)] } },
      select: { id: true, name: true },
    });
    // id → 名前 の表にする
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  // 作成 (名前重複は DuplicateError、プランの上限超過は 'too_many_agents')
  async create(input: CreateAgentInput, limits: AgentLimits): Promise<CreateAgentResult> {
    // **件数の判定と挿入を同じトランザクションに置き、テナント行をロックして直列化する** —
    // 数えてから挿入する形に分けると、同時に 2 件来たときにどちらの count も上限未満を返して
    // 上限を超える (`PrismaGuardrailRules.create` と同じ理由・同じ手口)
    return this.db.$transaction(async (tx: Db) => {
      // 同じテナントの要求を 1 本ずつ通す (子テーブル INSERT の FK 検査 (FOR KEY SHARE) とは衝突しない)。
      // **行が無い場合 (テナントが存在しない) はここでは判定しない** — 件数の上限とは別の事情を
      // `too_many_agents` に押し込むと「上限に達しています」という嘘の 409 になる。認証を通った
      // 主体のテナントは必ず存在するので、起きたときは挿入の FK 違反で大きな音を立てて落ちてよい
      // (memory 側は FK を持たないのでこの経路に差は現れない)
      await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${input.tenantId} FOR NO KEY UPDATE`;
      // **名前の重複を先に見る** — memory 側と答えをそろえる (ADR-0006 の死角。順序が割れると
      // 「上限に達していて、かつ名前も重複している」要求で 409 と 422 に答えが分かれる)
      const duplicate = await tx.agent.findFirst({
        where: { tenantId: input.tenantId, name: input.name },
        select: { id: true },
      });
      // 同名があれば一意制約違反として投げる (ルートが 422 へ写す)
      if (duplicate !== null) throw new DuplicateError('name');
      // 現在の件数を数える (同じトランザクションの中。外に出すと同時の 2 件が上限を超える)
      const existing = await tx.agent.count({ where: { tenantId: input.tenantId } });
      // 上限に達していれば作らない
      if (existing >= limits.maxAgents) return { status: 'too_many_agents' as const };
      // 挿入する。**一意制約違反の翻訳は残す** — 上の確認とこの挿入の間に同名が入る窓は
      // テナント行のロックで閉じているが、前提が崩れたときに別の原因へ化けさせない
      try {
        const agent = await tx.agent.create({ data: agentCreateData(input) });
        return { status: 'created' as const, agent };
      } catch (error) {
        rethrowDuplicate(error, 'name');
      }
    });
  }

  // 更新 (undefined は変更しない。対象が無ければ null、名前重複は DuplicateError)
  async update(tenantId: string, id: string, patch: UpdateAgentInput): Promise<AgentRecord | null> {
    // 複合一意 (tenantId, id) で 1 クエリで更新し、無ければ null・重複は翻訳する
    try {
      return await updateOrNull(() =>
        this.db.agent.update({
          where: { tenantId_id: { tenantId, id } },
          // 受け取った本文をそのまま渡さず、更新してよい項目だけを書き出す (agentUpdateData)
          data: agentUpdateData(patch),
        }),
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
    if (input.agentId === null) return this.db.apiKey.create({ data: apiKeyCreateData(input) });
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
      return tx.apiKey.create({ data: apiKeyCreateData(input) });
    });
  }

  // ハッシュで引く (プロキシの認証経路。**テナントを跨いで検索する唯一の操作**)
  async findByHash(keyHash: string): Promise<ApiKeyLookup | null> {
    // 一意なハッシュで検索し、紐づくエージェントと**テナントのプラン**を同時に読む (N+1 を避ける。
    // 中継はプラン別の枠でレート制限するので、プランは中継 1 回ごとに要る)
    const row = await this.db.apiKey.findUnique({
      where: { keyHash },
      include: { agent: true, tenant: { select: { plan: true } } },
    });
    // 無ければ null
    if (!row) return null;
    // エージェントとテナントの部分を分離して返す (テナント共通キーなら agent は null)
    const { agent, tenant, ...key } = row;
    return { key, agent, plan: tenant.plan };
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

// 集計の 1 行を SQL から受け取る形 (数値はすべて BIGINT で返させる。
// COUNT(*) と SUM() の戻りの型がプロバイダ次第で変わると、合計だけが静かに丸まる)
// ガードレールの窓の集計の戻り (集約関数は BIGINT を返すので bigint で受ける)
interface WindowTotalRow {
  requests: bigint;
  errorRequests: bigint;
  costMicroUsd: bigint;
}

interface DailyTotalRow {
  day: string;
  requests: bigint;
  errorRequests: bigint;
  inputTokens: bigint;
  outputTokens: bigint;
  costMicroUsd: bigint;
}

// 利用イベント Port の prisma 実装
class PrismaUsageEvents implements UsageEventsPort {
  // クライアントを受け取る
  constructor(private readonly db: PrismaClient) {}

  // 記録 (エージェントが同テナントに無ければ null)
  async record(input: RecordUsageEventInput): Promise<UsageEventRecord | null> {
    // 挿入を試みる
    try {
      return await this.db.usageEvent.create({ data: usageEventCreateData(input) });
    } catch (error) {
      // 複合 FK (tenantId, agentId) 違反 = 同テナントにそのエージェントが居ない
      if (isPrismaError(error, FOREIGN_KEY_VIOLATION)) return null;
      // それ以外は握り潰さず投げ直す
      throw error;
    }
  }

  // 日次集計 (UTC の日ごと。memory アダプタと同じ規則で、契約テストが両者の一致を固定する)
  async dailyTotals(tenantId: string, query: DailyUsageQuery): Promise<DailyUsageTotal[]> {
    // エージェントの絞り込み (指定が無ければ null を渡して条件を効かせない)
    const agentId = query.agentId ?? null;
    // 集計を 1 クエリで行う。**タグ付きテンプレート**なので値はすべてパラメータとして渡る
    // (guardRawSql() が許すのはこの形だけ。文字列連結の SQL は実行時に拒否される)。
    // 日の切り出しは date_trunc + to_char で、アプリ側の formatUtcDay と同じ 'YYYY-MM-DD' にそろえる。
    //
    // **`AT TIME ZONE 'UTC'` を書いてはいけない。** `createdAt` は `TIMESTAMP(3)`
    // (without time zone) に UTC の値をそのまま入れている列で、そこへ `AT TIME ZONE 'UTC'` を掛けると
    // `timestamptz` へ変換され、続く date_trunc / to_char が**接続セッションの TimeZone 設定**で評価される。
    // 期間の絞り込み (createdAt >= $start) は素の比較なので UTC のまま効き、**日のバケット分けだけが
    // ローカル時刻**という食い違いになる。実測 (セッション Asia/Tokyo): 2026-01-01T20:00Z と
    // 2026-01-01T02:00Z が 01-02 と 01-01 に割れ、memory アダプタとの一致検査が落ちた。
    // CI の postgres:16-alpine は既定が UTC なので、この食い違いは配備先でだけ現れる
    const rows = await this.db.$queryRaw<DailyTotalRow[]>`
      SELECT
        to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS "day",
        COUNT(*)::bigint AS "requests",
        COUNT(*) FILTER (WHERE "statusCode" >= ${USAGE_ERROR_STATUS_FLOOR})::bigint
          AS "errorRequests",
        COALESCE(SUM("inputTokens"), 0)::bigint AS "inputTokens",
        COALESCE(SUM("outputTokens"), 0)::bigint AS "outputTokens",
        COALESCE(SUM("costMicroUsd"), 0)::bigint AS "costMicroUsd"
      FROM "UsageEvent"
      WHERE "tenantId" = ${tenantId}
        AND "createdAt" >= ${query.start}
        AND "createdAt" < ${query.endExclusive}
        AND (${agentId}::text IS NULL OR "agentId" = ${agentId})
      GROUP BY 1
      ORDER BY 1
    `;
    // SQL の戻り (BIGINT) を Port の型へ写す
    return rows.map((row) => ({
      day: row.day,
      requests: toSafeCount(row.requests, '呼び出し回数'),
      errorRequests: toSafeCount(row.errorRequests, '失敗した呼び出し回数'),
      inputTokens: toSafeCount(row.inputTokens, '入力トークン'),
      outputTokens: toSafeCount(row.outputTokens, '出力トークン'),
      costMicroUsd: row.costMicroUsd,
    }));
  }

  // 任意の半開区間を 1 つの合計にまとめる (ガードレールの判定が使う。memory アダプタと同じ規則)。
  // **分母と分子を 1 クエリで取る** — 2 回に分けるとその間に入った呼び出しのぶん食い違い、
  // `3 / 0` のような測定値が生まれる (判定側は「測れない」として扱うが、作らないほうがよい)。
  // 失敗の下限は `USAGE_ERROR_STATUS_FLOOR` から渡す (数値を SQL に直書きしない)
  async windowTotals(tenantId: string, query: UsageWindowQuery): Promise<UsageWindowTotal> {
    // エージェントの絞り込み (指定が無ければ null を渡して条件を効かせない)
    const agentId = query.agentId ?? null;
    // 1 クエリで 3 つの合計を取る (タグ付きテンプレートなので値はすべてパラメータとして渡る)
    const rows = await this.db.$queryRaw<WindowTotalRow[]>`
      SELECT
        COUNT(*)::bigint AS "requests",
        COUNT(*) FILTER (WHERE "statusCode" >= ${USAGE_ERROR_STATUS_FLOOR})::bigint
          AS "errorRequests",
        COALESCE(SUM("costMicroUsd"), 0)::bigint AS "costMicroUsd"
      FROM "UsageEvent"
      WHERE "tenantId" = ${tenantId}
        AND "createdAt" >= ${query.start}
        AND "createdAt" < ${query.endExclusive}
        AND (${agentId}::text IS NULL OR "agentId" = ${agentId})
    `;
    // 集約関数は行が無くても 1 行返るが、欠けを 0 として扱う (fail-safe)
    const row = rows[0];
    // 行が取れなければ「何も無かった窓」として返す
    if (row === undefined) return { requests: 0, errorRequests: 0, costMicroUsd: 0n };
    // SQL の戻り (BIGINT) を Port の型へ写す
    return {
      requests: toSafeCount(row.requests, '呼び出し回数'),
      errorRequests: toSafeCount(row.errorRequests, '失敗した呼び出し回数'),
      costMicroUsd: row.costMicroUsd,
    };
  }
}

// 評価 Port の prisma 実装。**ケースは必ず親のセット経由で辿る** (子テーブルに tenantId が無いので、
// setId だけで直接引くとテナント境界を跨げる。docs/spec.md §3)
class PrismaEvaluations implements EvaluationsPort {
  // クライアントを受け取る
  constructor(private readonly db: PrismaClient) {}

  // 評価セットを作る (名前重複は DuplicateError)
  async createSet(input: CreateEvaluationSetInput): Promise<EvaluationSetWithCases> {
    // セットとケースを 1 つのトランザクションで入れる (途中で落ちてケースだけ残る状態を作らない)
    try {
      // 入れ子の create でケースごと作る
      const created = await this.db.evaluationSet.create({
        data: {
          tenantId: input.tenantId,
          name: input.name,
          // 配列の順がそのまま position になる
          cases: {
            create: input.cases.map((item, index) => ({
              position: index,
              input: item.input,
              expected: item.expected,
            })),
          },
        },
        // 作ったケースも position 昇順で受け取る
        include: { cases: { orderBy: { position: 'asc' } } },
      });
      // セットとケースに分けて返す
      const { cases, ...set } = created;
      return { set, cases };
    } catch (error) {
      // 同じテナントに同じ名前のセットがあれば 422 へ翻訳する
      rethrowDuplicate(error, 'name');
    }
  }

  // セットの一覧 (テナントで絞る)
  async listSets(tenantId: string, query: PageQuery): Promise<Page<EvaluationSetRecord>> {
    // 1 件多く取って Page へ整形する
    const rows = await this.db.evaluationSet.findMany(pageArgs(query, { tenantId }));
    return toPage(rows, query.limit);
  }

  // セットをケースごと引く (テナント境界を跨がない)
  async findSet(tenantId: string, setId: string): Promise<EvaluationSetWithCases | null> {
    // 複合一意 (tenantId, id) で引き、ケースは position 昇順で付ける
    const found = await this.db.evaluationSet.findUnique({
      where: { tenantId_id: { tenantId, id: setId } },
      include: { cases: { orderBy: { position: 'asc' } } },
    });
    // 見つからなければ null (他テナントのセットも同じ)
    if (found === null) return null;
    // セットとケースに分けて返す
    const { cases, ...set } = found;
    return { set, cases };
  }

  // 実行結果を保存する (エージェントかセットが同テナントに無ければ null)
  async createRun(input: CreateEvaluationRunInput): Promise<EvaluationRunWithResults | null> {
    // 実行と結果を 1 つのトランザクションで入れる
    try {
      // 入れ子の create で結果ごと作る
      const created = await this.db.evaluationRun.create({
        data: {
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
          // 結果はケース単位。**tenantId / setId は書かない** — どちらも親の実行への複合 FK
          // (tenantId, runId, setId) の一部なので Prisma が実行の値から埋める。
          // 明示すると「Unknown argument」で落ちるうえ、書けると実行とずれた値を入れられてしまう
          results: {
            create: input.results.map((item) => ({
              caseId: item.caseId,
              accuracy: item.accuracy,
              safety: item.safety,
              deviation: item.deviation,
              excludedReason: item.excludedReason,
            })),
          },
        },
        // 結果はケースの position 昇順で受け取る
        include: { results: { orderBy: { evaluationCase: { position: 'asc' } } } },
      });
      // 実行と結果に分けて返す
      const { results, ...run } = created;
      return { run, results };
    } catch (error) {
      // 複合 FK 違反 = 同テナントにそのエージェント/セット/ケースが居ない
      if (isPrismaError(error, FOREIGN_KEY_VIOLATION)) return null;
      // それ以外は握り潰さず投げ直す
      throw error;
    }
  }

  // 実行の一覧 (テナント + エージェント + セットで絞る)
  async listRuns(
    tenantId: string,
    query: PageQuery,
    filter: EvaluationRunFilter = {},
  ): Promise<Page<EvaluationRunRecord>> {
    // 絞り込み条件 (指定があるものだけ足す)
    const where = {
      tenantId,
      ...(filter.agentId !== undefined ? { agentId: filter.agentId } : {}),
      ...(filter.setId !== undefined ? { setId: filter.setId } : {}),
    };
    // 1 件多く取って Page へ整形する
    const rows = await this.db.evaluationRun.findMany(pageArgs(query, where));
    return toPage(rows, query.limit);
  }

  // 実行を結果ごと引く (テナント境界を跨がない)
  async findRun(tenantId: string, runId: string): Promise<EvaluationRunWithResults | null> {
    // テナントと id の両方で絞る (複合一意は (tenantId, id, setId) なので findFirst で引く)
    const found = await this.db.evaluationRun.findFirst({
      where: { tenantId, id: runId },
      include: { results: { orderBy: { evaluationCase: { position: 'asc' } } } },
    });
    // 見つからなければ null (他テナントの実行も同じ)
    if (found === null) return null;
    // 実行と結果に分けて返す
    const { results, ...run } = found;
    return { run, results };
  }

  // 同じエージェント × セットの、その実行より前の最新の実行 (回帰比較の相手)
  async findPreviousRun(
    tenantId: string,
    run: EvaluationRunRecord,
  ): Promise<EvaluationRunRecord | null> {
    // 並び順は一覧と同じ (createdAt, id) の昇順なので、その位置より「前」を降順の先頭で引く。
    // 同時刻の実行が 2 件あっても id で決まるので、比較相手が入れ替わらない。
    // **failed の実行は比較相手にしない** — 除外が多すぎてスコアが null なので、
    // 比べても差が出ず「前回より下がった/上がった」を判定できない
    // (prisma/schema.prisma の status の説明どおり、回帰比較の材料から外す)
    return this.db.evaluationRun.findFirst({
      where: {
        tenantId,
        agentId: run.agentId,
        setId: run.setId,
        status: EvaluationRunStatus.completed,
        // **同じ judge で採点した実行だけを相手にする** (schema.prisma の judgeProvider の説明)。
        // 別の judge の採点と比べた差は「エージェントが変わった」ことを示さないのに、
        // 応答は差の数値しか返さないので、judge を替えた直後の回帰に見えてしまう
        judgeProvider: run.judgeProvider,
        judgeModel: run.judgeModel,
        OR: [
          { createdAt: { lt: run.createdAt } },
          { createdAt: run.createdAt, id: { lt: run.id } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  // そのエージェントの最新の completed な実行 (品質低下ルールが読む相手)。
  // **failed は飛ばす** — 除外が多すぎた実行のスコアは null で、それを「品質が落ちた」と
  // 読むのは誤判定 (採点できていないことと品質が低いことは別)
  async findLatestCompletedRun(
    tenantId: string,
    agentId: string | null,
    since?: Date,
    until?: Date,
  ): Promise<EvaluationRunRecord | null> {
    // 期間の条件を 1 つのオブジェクトにまとめる (両方省略なら条件を付けない)。
    // **gte と lt を別の createdAt キーに分けて書けない**ので、ここで合成する
    const createdAt = {
      ...(since === undefined ? {} : { gte: since }),
      ...(until === undefined ? {} : { lt: until }),
    };
    // 一覧と同じ並び (createdAt, id) の降順で先頭を取る (同時刻でも相手が入れ替わらない)。
    // **`agentId` が null ならテナント全体**から探す (ダッシュボードの品質カード)
    return this.db.evaluationRun.findFirst({
      where: {
        tenantId,
        ...(agentId === null ? {} : { agentId }),
        status: EvaluationRunStatus.completed,
        ...(Object.keys(createdAt).length === 0 ? {} : { createdAt }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }
}

// ── ガードレールのルール ──────────────────────────
class PrismaGuardrailRules implements GuardrailRulesPort {
  // クライアントを受け取る
  constructor(private readonly db: PrismaClient) {}

  // ルールを作る。**件数の判定と挿入を同じトランザクションに置き、テナント行をロックして直列化する** —
  // 数えてから挿入する形に分けると、同時に 2 件来たときにどちらの count も上限未満を返して上限を超える
  // (「最後の有効な admin」判定と同じ理由・同じ手口)
  async create(
    input: CreateGuardrailRuleInput,
    limits: GuardrailRuleLimits,
  ): Promise<CreateGuardrailRuleResult> {
    // 1 つのトランザクションで「ロック → 数える → 挿入」を行う
    return this.db.$transaction(async (tx) => {
      // 同じテナントの要求を 1 本ずつ通す (子テーブル INSERT の FK 検査 (FOR KEY SHARE) とは衝突しない)
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "Tenant" WHERE id = ${input.tenantId} FOR NO KEY UPDATE`;
      // テナントが無ければ作れない (エージェントが見つからないのと同じ扱いで存在を隠す)
      if (locked.length === 0) return { status: 'agent_not_found' as const };
      // **対象エージェントの確認は件数の判定より前に行う** — memory アダプタと答えを揃えるため
      // (ADR-0006 の構造的な死角)。挿入時の FK 違反だけに頼ると「上限に達していて、かつ
      // エージェント id も誤っている」要求で件数の判定が先に返り、memory は agent_not_found・
      // prisma は too_many_rules を返す。API テストは memory で走るので、答えが割れると
      // ルートは片方の答えで書かれて本番だけ別のステータスになる
      if (input.agentId !== null) {
        // 同テナントにそのエージェントが居るか。**FOR KEY SHARE で押さえる** —
        // 削除だけを待たせ、状態変更や他のルール作成は妨げない。押さえれば挿入は複合 FK
        // (tenantId, agentId) を必ず満たすので、**FK 違反の翻訳に頼らずに済む**
        // (`PrismaApiKeys.create` と同じ形。理由はそちらのコメント)
        const agent = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM "Agent" WHERE "tenantId" = ${input.tenantId} AND id = ${input.agentId} FOR KEY SHARE`;
        // 居なければ作れない (他テナントのエージェントも「無い」と同じ扱いにして存在を隠す)
        if (agent.length === 0) return { status: 'agent_not_found' as const };
      }
      // 現在の**有効な**ルール数を数える (無効化したものは数えない。理由は Port のコメント)
      const existing = await tx.guardrailRule.count({
        where: { tenantId: input.tenantId, enabled: true },
      });
      // 有効なルールの上限に達していれば作らない
      if (existing >= limits.maxEnabled) return { status: 'too_many_rules' as const };
      // **行数 (有効・無効の両方) も数えて天井を掛ける** — 無効化した行を上の判定で
      // 数えないぶん、これが無いと「作る → 無効化する」の繰り返しで行が無制限に増える。
      // **同じトランザクションの中で数える** (上の判定と同じ理由。外に出すと同時の 2 件が天井を超える)
      const rows = await tx.guardrailRule.count({ where: { tenantId: input.tenantId } });
      // 行数の上限に達していれば作らない
      if (rows >= limits.maxRows) return { status: 'too_many_rows' as const };
      // 挿入する。**FK 違反 (P2003) を翻訳しない** — 2 本の FK (Tenant / Agent) のうち
      // Tenant 側は上の FOR NO KEY UPDATE が、Agent 側は上の FOR KEY SHARE が削除を待たせるので、
      // ここで FK 違反は起こらない。それでも起きたなら前提が崩れているので、別の原因を
      // 「エージェントが見つからない」に化けさせずそのまま投げる (`PrismaApiKeys.create` と同じ規則。
      // Prisma 7 のドライバアダプタ経由のエラーは「どの制約か」を安定した形で持たないため)
      const rule = await tx.guardrailRule.create({
        data: {
          tenantId: input.tenantId,
          agentId: input.agentId,
          kind: input.kind,
          threshold: input.threshold,
          windowMinutes: input.windowMinutes,
          action: input.action,
        },
      });
      // 作成できた
      return { status: 'created' as const, rule };
    });
  }

  // ルールを一覧する (テナント内、createdAt 昇順)
  async list(tenantId: string, query: PageQuery): Promise<Page<GuardrailRuleRecord>> {
    // 共通のページネーション (1 件多く取って次ページの有無を知る)
    const rows = await this.db.guardrailRule.findMany(pageArgs(query, { tenantId }));
    // ページに整形する
    return toPage(rows, query.limit);
  }

  // 有効・無効を切り替える (他テナントの id は null)。冪等 — 既に同じ値でも現在の行を返す。
  // **複合一意 (tenantId, id) の update 1 回**で済ませる (findById → update の 2 往復にしない。
  // 間に消えると 500 になる)。P2025 は「無い」に翻訳する
  async setEnabled(
    tenantId: string,
    ruleId: string,
    enabled: boolean,
    maxEnabled: number,
  ): Promise<SetGuardrailRuleEnabledResult> {
    // **数えてから書き換えるので 1 トランザクションに入れる** — 外で数えると、同時の 2 件が
    // どちらも「まだ上限に達していない」と読んで上限を超える (create と同じ理由)
    return this.db.$transaction(async (tx) => {
      // 対象行をテナント条件込みで押さえる。**FOR NO KEY UPDATE** で同じ行への切り替えを
      // 直列化する (削除は待たせるが、子テーブルの FK 検査とは衝突させない)
      const locked = await tx.$queryRaw<
        { enabled: boolean }[]
      >`SELECT enabled FROM "GuardrailRule" WHERE "tenantId" = ${tenantId} AND id = ${ruleId} FOR NO KEY UPDATE`;
      // 他テナントの id・存在しない id は「無い」(存在を隠す)
      if (locked.length === 0) return { status: 'not_found' as const };
      // **有効へ戻すときだけ上限を数え直す** (既に有効な行はその数に入っているので数えない)。
      // 数えないと「上限まで作る → 全部無効化する → また作る → 最初の分を戻す」で上限を超える
      if (enabled && locked[0]?.enabled === false) {
        // そのテナントの有効なルール数
        const active = await tx.guardrailRule.count({ where: { tenantId, enabled: true } });
        // 上限に達していれば戻せない (行は変えない)
        if (active >= maxEnabled) return { status: 'too_many_rules' as const };
      }
      // テナント条件込みの複合一意で更新する (上で押さえたので必ず見つかる)
      const rule = await tx.guardrailRule.update({
        where: { tenantId_id: { tenantId, id: ruleId } },
        data: { enabled },
      });
      // 切り替えた後の行
      return { status: 'ok' as const, rule };
    });
  }

  // ルールを消す (インシデントを持つルールは消せない = DB の Restrict FK)
  async delete(tenantId: string, ruleId: string): Promise<DeleteGuardrailRuleResult> {
    // 削除を試みる
    try {
      // 複合一意 (tenantId, id) で 1 回だけ消す (他テナントの id は見つからない)
      await this.db.guardrailRule.delete({ where: { tenantId_id: { tenantId, id: ruleId } } });
      // 消せた
      return 'deleted';
    } catch (error) {
      // 無い行の削除は P2025
      if (isPrismaError(error, RECORD_NOT_FOUND)) return 'not_found';
      // インシデントから参照されている (Restrict)
      if (isPrismaError(error, FOREIGN_KEY_VIOLATION)) return 'restricted';
      // それ以外は握り潰さず投げ直す
      throw error;
    }
  }

  // 判定の対象になる有効なルールを引く (エージェント指定のものとテナント全体のものの和集合)
  async findActiveRules(tenantId: string, query: ActiveRuleQuery): Promise<GuardrailRuleRecord[]> {
    // 種別の絞り込み (指定が無ければ条件を付けない)
    const kindFilter = query.kinds === undefined ? {} : { kind: { in: [...query.kinds] } };
    // テナント内の有効なルールのうち、対象エージェント向けか agentId が null のもの
    return this.db.guardrailRule.findMany({
      where: {
        tenantId,
        enabled: true,
        ...kindFilter,
        OR: [{ agentId: query.agentId }, { agentId: null }],
      },
      // 並びを決定的にする (memory アダプタと同じ順序)
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }
}

// ── インシデント ──────────────────────────
class PrismaIncidents implements IncidentsPort {
  // クライアントを受け取る
  constructor(private readonly db: PrismaClient) {}

  // 発火を記録し、必要なら**同じトランザクションで**エージェントを停止する。
  // 1 つの操作にするのは、片方だけ成立した状態 (止まったが記録が無い / 記録はあるが止まっていない) を
  // 作らないため。受け入れ基準「発火から停止まで ≦ 3 秒」も、記録と停止が同じ往復で終わることで満たす
  async raise(input: RaiseIncidentInput): Promise<RaisedIncident | null> {
    // **停止を伴わない判定で、既に開いている記録があるなら何も書かない。**
    // この経路はロックもトランザクションも取らない — `notify` のルールは超過が解消するまで
    // 自分では止まらないので、窓のあいだ**中継 1 回ごとに**ここへ来る。毎回エージェント行を
    // `FOR NO KEY UPDATE` で押さえていると、同じエージェントへの中継が 1 件ずつ直列化して
    // スループットが「DB の往復 1 回ぶん」に落ちる (しかも結果は毎回 created: false で
    // 呼び出し側が捨てる = 何も書かないための待ち合わせ)。
    //
    // **先読みなので取り逃しは起きる** (読んだ直後に別の要求が作る)。そのときは下の経路へ
    // 落ちて同じ答えになるだけで、重複排除はトランザクションの中の判定が担保する。
    // **停止を伴う判定ではこの近道を使わない** — 開いている記録があっても、その間に
    // 復帰させられたエージェントは再び止める必要がある (重複排除と停止は独立)
    if (!input.suspendAgent) {
      // 同じルール・同じエージェントで開いている記録 (テナント条件込み)
      const open = await this.db.incident.findFirst({
        where: {
          tenantId: input.tenantId,
          agentId: input.agentId,
          ruleId: input.ruleId,
          status: IncidentStatus.open,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      // 見つかれば書き込みも停止も要らない (下の経路と同じ答えを返す)
      if (open !== null) return { incident: open, suspended: false, created: false };
    }
    // 1 つのトランザクションで「記録 → 必要なら停止」を行う
    return this.db.$transaction(async (tx) => {
      // 対象エージェントの状態をロックして読む (停止の判定とこの後の更新を直列化する)
      const locked = await tx.$queryRaw<
        { status: AgentStatus }[]
      >`SELECT status FROM "Agent" WHERE "tenantId" = ${input.tenantId} AND id = ${input.agentId} FOR NO KEY UPDATE`;
      // 同テナントに居なければ記録しない
      if (locked.length === 0) return null;
      // 記録を試みる (ルールが同テナントに無ければ複合 FK 違反になる)
      try {
        // **同じルール・同じエージェントで既に開いているインシデントを探す。**
        // 見つかれば新しい行は作らない (超過が続くあいだ行が増え続けるのを防ぐ。理由は Port の
        // `created` のコメント)。エージェント行をロックしてから読むので、同時の 2 件が
        // どちらも「無い」を見て 2 行作ることは起きない
        const open = await tx.incident.findFirst({
          where: {
            tenantId: input.tenantId,
            agentId: input.agentId,
            ruleId: input.ruleId,
            status: IncidentStatus.open,
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        // 開いている行が無ければ作る (あればそれを使う)
        const incident =
          open ??
          (await tx.incident.create({
            data: {
              tenantId: input.tenantId,
              agentId: input.agentId,
              ruleId: input.ruleId,
              summary: input.summary,
            },
          }));
        // 停止を要求されていて、かつ今が稼働中なら suspended にする。
        // **既に stopped / suspended のときは状態を変えない** — 手動停止を自動停止で塗り替えると、
        // 復帰の判断 (誰が止めたのか) が読めなくなる。
        // **重複排除とは独立に判定する** — 開いているインシデントがあっても、その間に復帰させた
        // エージェントは再び止める (止めないと「超過しているのに動いている」状態が残る)
        const suspended = input.suspendAgent && locked[0].status === AgentStatus.active;
        // 状態を変えるときだけ更新する
        if (suspended) {
          await tx.agent.update({
            where: { tenantId_id: { tenantId: input.tenantId, id: input.agentId } },
            data: { status: AgentStatus.suspended },
          });
        }
        // 記録・新規かどうか・「実際に止めたか」を返す
        return { incident, suspended, created: open === null };
      } catch (error) {
        // 複合 FK (tenantId, ruleId) 違反 = 同テナントにそのルールが無い
        if (isPrismaError(error, FOREIGN_KEY_VIOLATION)) return null;
        // それ以外は握り潰さず投げ直す
        throw error;
      }
    });
  }

  // インシデントを一覧する (テナント内、createdAt 昇順。絞り込みは任意)
  async list(
    tenantId: string,
    query: PageQuery,
    filter?: IncidentFilter,
  ): Promise<Page<IncidentRecord>> {
    // 共通のページネーション (絞り込みは undefined なら条件に入れない)
    const rows = await this.db.incident.findMany(
      pageArgs(query, {
        tenantId,
        ...(filter?.agentId === undefined ? {} : { agentId: filter.agentId }),
        ...(filter?.status === undefined ? {} : { status: filter.status }),
      }),
    );
    // ページに整形する
    return toPage(rows, query.limit);
  }

  // インシデントを引く (他テナントのものは null)
  async findById(tenantId: string, incidentId: string): Promise<IncidentRecord | null> {
    // 複合一意で引く (他テナントの id は見つからない)
    return this.db.incident.findFirst({ where: { tenantId, id: incidentId } });
  }

  // 解決済みにする (既に解決済みなら 'already_resolved')
  async resolve(tenantId: string, incidentId: string): Promise<ResolveIncidentResult> {
    // **条件付き更新で「開いているものだけ」を閉じる** — 読んでから書く形に分けると、
    // 同時に 2 回呼ばれたときに両方が 'resolved' を返して監査ログが二重に残る
    const updated = await this.db.incident.updateMany({
      where: { tenantId, id: incidentId, status: IncidentStatus.open },
      data: { status: IncidentStatus.resolved, resolvedAt: new Date() },
    });
    // 1 行更新できたなら解決した
    if (updated.count > 0) return 'resolved';
    // 更新できなかったので、行そのものが無いのか既に解決済みなのかを見分ける
    const existing = await this.db.incident.findFirst({
      where: { tenantId, id: incidentId },
      select: { status: true },
    });
    // 行が無ければ「無い」、あれば既に解決済み
    return existing === null ? 'not_found' : 'already_resolved';
  }
}

// ── 監査ログ ──────────────────────────
class PrismaAuditLogs implements AuditLogsPort {
  // クライアントを受け取る
  constructor(private readonly db: PrismaClient) {}

  // 1 行を追記する。**直前の行をロックしてから採番する** —
  // ロックが無いと、同時に 2 つの要求が同じ seq を採って一意制約で片方が落ちる (連鎖は壊れないが
  // 操作が失敗する) か、prevHash が同じ行を 2 つ作って連鎖が枝分かれする
  async append(
    input: AppendAuditLogInput,
    computeHash: (hashInput: AuditHashInput) => string,
  ): Promise<AuditLogRecord> {
    // 1 つのトランザクションで「ロック → 採番 → ハッシュ → 挿入」を行う
    return this.db.$transaction(async (tx) => {
      // そのテナントの行を**テナント行のロックで**直列化する。
      // **監査ログの最後の行そのものをロックできない** — 1 行も無いテナントではロックする行が無く、
      // 「無いことのロック」は行ロックでは表せない (ギャップロックは PostgreSQL に無い)。
      // テナント行を掴めば、同じテナントの追記は 1 本ずつ通る
      await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${input.tenantId} FOR NO KEY UPDATE`;
      // 直前の行 (seq が最大のもの) を引く
      const previous = await tx.auditLog.findFirst({
        where: { tenantId: input.tenantId },
        orderBy: { seq: 'desc' },
        select: { seq: true, hash: true },
      });
      // 次の連番 (直前が無ければ 1)
      const seq = nextAuditSeq(previous?.seq ?? null);
      // 直前の行のハッシュ (最初の行は null)
      const prevHash = previous?.hash ?? null;
      // **id を先に決める** — ハッシュの入力に id が入るので、DB の既定値 (cuid) に任せられない
      // (既定値に任せると、挿入後に返ってきた id でハッシュを計算し直して UPDATE することになり、
      //  追記専用トリガが UPDATE を拒否する = そもそも書けない)。
      // **この表だけアプリが id を決める。** 形は `isResourceId` の許す範囲に収まり
      // (英数字と `-`)、`randomUUID` は標準ライブラリの暗号学的乱数なので推測もできない
      const id = randomUUID();
      // ハッシュを計算してもらう (鍵と計算方法はアプリ側が持つ。アダプタは鍵に触らない)
      const hash = computeHash({ seq, prevHash, id });
      // 挿入する (createdAt も呼び出し側の値をそのまま入れる。DB の既定値に任せると
      // ハッシュに入れた時刻と保存される時刻が別の瞬間になり、全行が検証に失敗する)
      return tx.auditLog.create({
        data: {
          id,
          tenantId: input.tenantId,
          actorId: input.actorId,
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId,
          payload: input.payload === null ? Prisma.DbNull : input.payload,
          createdAt: input.createdAt,
          seq,
          prevHash,
          hash,
        },
      });
    });
  }

  // 一覧する (テナント内、createdAt 昇順)
  async list(tenantId: string, query: PageQuery): Promise<Page<AuditLogRecord>> {
    // 共通のページネーション
    const rows = await this.db.auditLog.findMany(pageArgs(query, { tenantId }));
    // ページに整形する
    return toPage(rows, query.limit);
  }

  // 連鎖の検証のために seq 昇順で読む (上限付き)
  async readChain(
    tenantId: string,
    limit: number,
    fromSeq?: bigint,
  ): Promise<{ rows: AuditLogRecord[]; reachedLimit: boolean; anchorHash: string | null }> {
    // 読み始める連番 (省略時は先頭)
    const start = fromSeq ?? FIRST_AUDIT_SEQ;
    // 上限より 1 件多く取り、続きがあるかを知る
    const rows = await this.db.auditLog.findMany({
      where: { tenantId, seq: { gte: start } },
      orderBy: { seq: 'asc' },
      take: limit + 1,
    });
    // 上限に達したか
    const reachedLimit = rows.length > limit;
    // **直前の行のハッシュ**(途中から検証するときの錨)。先頭から読むなら錨は無い
    const previous =
      start <= FIRST_AUDIT_SEQ
        ? null
        : await this.db.auditLog.findFirst({
            where: { tenantId, seq: { lt: start } },
            orderBy: { seq: 'desc' },
            select: { hash: true },
          });
    // 返すのは上限までの分
    return {
      rows: reachedLimit ? rows.slice(0, limit) : rows,
      reachedLimit,
      anchorHash: previous?.hash ?? null,
    };
  }
}

// 受信した課金イベント (冪等性の記録)
class PrismaBillingEvents implements BillingEventsPort {
  // クライアントを受け取る
  constructor(private readonly db: PrismaClient) {}

  // 1 度だけ記録し、同じトランザクションでプランを反映する (2 通目は duplicate)
  async recordOnce(
    input: RecordBillingEventInput,
    apply: BillingPlanApplication | null,
  ): Promise<RecordBillingEventResult> {
    // **どちらの文で一意制約に当たったか**を外側の catch へ伝える。
    // meta の形から列名を当てる推測に頼らない — ドライバが形を変えた瞬間に「読めなかった」へ倒れ、
    // ただの再送が `DuplicateError` → 422 になる (事業者は失敗と読んで再送を増やす)
    let failedAt: 'event' | 'tenant' = 'event';
    // **記録と反映を 1 つのトランザクションにする** — 記録だけが先に確定すると、反映に失敗した
    // イベントが「もう処理した」になり再送でもやり直せない (= 永久に反映されない)
    try {
      return await this.db.$transaction(async (tx: Db) => {
        // **受信を先に記録する** — 一意制約に当たればこの文が最初に落ちるので、
        // 「2 通目」と「連携の衝突」を取り違えようがない (エラーは tx の外で受けるので
        // PostgreSQL の「中断済みトランザクション」にも触れない)
        await tx.billingEvent.create({
          data: {
            provider: input.provider,
            eventId: input.eventId,
            type: input.type,
            tenantId: input.tenantId,
          },
        });
        // 反映が要らないなら記録だけで終わり
        if (apply === null) return { outcome: 'recorded' as const, tenant: null };
        // ここから先の一意制約違反は連携の列
        failedAt = 'tenant';
        // **条件付き更新で「対象が居るか」と「いまの契約か」を同時に見る** — 読んでから書くまでの
        // 間に契約が変わりうるので、呼び出し側が読んだ行で判断すると古い解約が新しい契約を打ち消す。
        // 0 件なら反映しない (居ない / 条件に合わない のどちらでも記録だけ残す)
        const { count } = await tx.tenant.updateMany({
          where: {
            id: apply.tenantId,
            ...(apply.expectSubscriptionId === null
              ? {}
              : { billingSubscriptionId: apply.expectSubscriptionId }),
          },
          data: tenantPlanData(apply.update),
        });
        // 反映できたときだけ行を読み直して返す
        const tenant =
          count === 0 ? null : await tx.tenant.findUnique({ where: { id: apply.tenantId } });
        return { outcome: 'recorded' as const, tenant };
      });
    } catch (error) {
      // 一意制約違反でなければ原因を隠さずそのまま投げる
      if (!isPrismaError(error, UNIQUE_VIOLATION)) throw error;
      // 受信記録の挿入で当たったなら「もう記録済み」= 2 通目 (反映も一緒に巻き戻っている)
      if (failedAt === 'event') return { outcome: 'duplicate', tenant: null };
      // それ以外は連携の衝突 (2 テナントが同じ契約を名乗る)。`updatePlan` と同じ翻訳にそろえる
      rethrowDuplicateAmong(error, ['billingCustomerId', 'billingSubscriptionId']);
    }
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
    usageEvents: new PrismaUsageEvents(db),
    evaluations: new PrismaEvaluations(db),
    guardrailRules: new PrismaGuardrailRules(db),
    incidents: new PrismaIncidents(db),
    auditLogs: new PrismaAuditLogs(db),
    billingEvents: new PrismaBillingEvents(db),
  };
}
