// prisma アダプタの契約テスト (実 PostgreSQL)。memory アダプタと同じ挙動 (テナント境界・一意制約・複合 FK・
// Restrict / Cascade・ページネーション) を本番実装で固定する。
// RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で全テーブルを TRUNCATE するため開発 DB を指さないこと
// (CI は専用 DB agent_ops_contract を作って流す。CLAUDE.md §2)
// prisma アダプタとクライアント結線は **動的 import** で読む (静的に import すると生成物 src/generated/prisma が
// テストの収集時に要求され、skipIf で飛ばすはずの `npm run test` が `db:generate` 無しでは落ちる)
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DuplicateError } from '@/data/errors';
import { decodeCursor } from '@/data/page';
import type { Repositories } from '@/data/ports';
import { AgentStatus, Plan, Provider, Role } from '@/domain/types';
import { userTokenExpiresAt } from '@/lib/tokens';
// 接続先が契約テスト専用 DB であることの確認 (入口ガード・setupFiles と同じ関数を呼ぶ)
import { runContractDatabaseGuard } from '../../scripts/lib/contract-database.mjs';

// 明示フラグが無ければ丸ごとスキップする
const ENABLED = process.env.RUN_PRISMA_CONTRACT === '1';

// 外部キー違反の Prisma のエラーコード (「別の理由で失敗した」を取り違えないために突き合わせる)
const FOREIGN_KEY_VIOLATION = 'P2003';

// ロックの検査で「待たされている」と判定するまでの待ち時間 (ミリ秒)。ロックが無ければ降格は
// 数ミリ秒で終わるので、これだけ待って終わらなければロック待ちだと判断できる
const LOCK_TEST_WAIT_MS = 500;
// ロックを保持する側のトランザクション上限 (ミリ秒)。待ち時間より十分長くする
const LOCK_TEST_TRANSACTION_TIMEOUT_MS = 10_000;

// テストで発行するトークンの有効期間 (日)
const TOKEN_TTL_DAYS = 1;

// テナントを 1 つ作る (admin + トークン込み)
async function makeTenant(repos: Repositories, label: string) {
  // ハッシュはテストごとに一意ならよい
  return repos.tenants.createWithAdmin({
    name: `テナント${label}`,
    admin: { email: `admin-${label}@example.com`, name: `管理者${label}` },
    token: {
      prefix: 'aop_u_test',
      tokenHash: `hash-${label}-${Date.now()}`,
      name: '初期',
      expiresAt: userTokenExpiresAt(TOKEN_TTL_DAYS),
    },
  });
}

// 「入力の各項目が、そのまま保存されているか」を入力のキーから導いて確かめる。
// 本番アダプタは入力を `data:` へ丸ごと渡さず 1 項目ずつ写しているので、写し先を別の値へ書き換えても
// 「項目の過不足」を見る型検査は通ってしまう (型は値の出どころまでは表せない)。実測では role を admin 固定に、
// expiresAt を 100 年後固定にする変異がどちらも全件緑だった — 前者は招待が権限昇格になり、後者は
// ADR-0005 の「無期限は作れない」が本番でだけ崩れる。
// 列名を手で並べず入力のキーから回すので、入力に項目が増えれば表明も自動で広がる
function expectStoredAsGiven<T extends object>(row: T, input: Partial<Record<keyof T, unknown>>) {
  // 入力が空なら走査が空振りしている (fail-closed)
  expect(Object.keys(input).length).toBeGreaterThan(0);
  // 入力の各項目が保存された行に同じ値で載っていること
  for (const [key, value] of Object.entries(input)) {
    expect(row[key as keyof T], `${key} が入力どおりに保存されていない`).toEqual(value);
  }
}

describe.skipIf(!ENABLED)('prisma アダプタの契約', () => {
  // 実 DB へのクライアント (本番と同じ遅延生成 Proxy) とリポジトリ
  let client: typeof import('@/lib/prisma').prisma;
  let repos: Repositories;

  // 接続する (生成物へ依存するモジュールはここで初めて読む)。リポジトリは本番と同じ Composition Root
  // (getRepos の動的 import 経由) から取る — アダプタの結線が壊れても他のジョブは緑のままなので、ここで通す。
  // TRUNCATE と切断には同じ singleton (遅延生成 Proxy) を使う
  beforeAll(async () => {
    // 接続先が専用 DB であること (TRUNCATE する前に確かめる)。setupFiles でも同じ関数が走るが、
    // TRUNCATE と同じファイルにも置く — 設定側の 1 行が消えたときの最後の砦になる
    runContractDatabaseGuard();
    const [{ prisma }, { getRepos }] = await Promise.all([
      import('@/lib/prisma'),
      import('@/data'),
    ]);
    client = prisma;
    repos = await getRepos();
  });

  // 全テーブルを空にする (Tenant を起点に CASCADE で子も消える)
  beforeEach(async () => {
    // 値を埋め込まないタグ付きテンプレートで流す ($executeRawUnsafe は実行時ガードが禁止している)
    await client.$executeRaw`TRUNCATE TABLE "Tenant" CASCADE`;
  });

  // 切断する
  afterAll(async () => {
    await client?.$disconnect();
  });

  it('createWithAdmin はテナント・admin・トークンを作り、ハッシュで引くとユーザーも取れる', async () => {
    // 作成
    const created = await makeTenant(repos, 'A');
    expect(created.admin.role).toBe(Role.admin);
    expect(created.admin.tenantId).toBe(created.tenant.id);
    // ハッシュ照合
    const found = await repos.userTokens.findByHash(created.token.tokenHash);
    expect(found?.user.id).toBe(created.admin.id);
    expect(found?.token.id).toBe(created.token.id);
    // 無いハッシュは null
    expect(await repos.userTokens.findByHash('nope')).toBeNull();
  });

  it('ユーザーのメールはテナント内で一意 (DuplicateError)、別テナントなら重複できる', async () => {
    // 2 テナント
    const a = await makeTenant(repos, 'A');
    const b = await makeTenant(repos, 'B');
    // 同テナントで重複
    await expect(
      repos.users.create({
        tenantId: a.tenant.id,
        email: a.admin.email,
        name: 'x',
        role: Role.viewer,
      }),
    ).rejects.toBeInstanceOf(DuplicateError);
    // 別テナントなら可
    const other = await repos.users.create({
      tenantId: b.tenant.id,
      email: a.admin.email,
      name: 'x',
      role: Role.viewer,
    });
    expect(other.tenantId).toBe(b.tenant.id);
  });

  it('エージェントはテナント境界を跨いで見えず、名前はテナント内で一意', async () => {
    // 2 テナントに 1 件ずつ
    const a = await makeTenant(repos, 'A');
    const b = await makeTenant(repos, 'B');
    const agent = await repos.agents.create({
      tenantId: a.tenant.id,
      name: 'bot',
      description: null,
      provider: Provider.anthropic,
      model: 'claude-sonnet-4-6',
      budgetMicroUsd: 123n,
    });
    // 他テナントからは null
    expect(await repos.agents.findById(b.tenant.id, agent.id)).toBeNull();
    expect(await repos.agents.update(b.tenant.id, agent.id, { name: 'x' })).toBeNull();
    expect(await repos.agents.setStatus(b.tenant.id, agent.id, 'stopped')).toBe(null);
    expect(await repos.agents.delete(b.tenant.id, agent.id)).toBe('not_found');
    // 同テナントで名前重複
    await expect(
      repos.agents.create({
        tenantId: a.tenant.id,
        name: 'bot',
        description: null,
        provider: Provider.openai,
        model: 'gpt-5',
        budgetMicroUsd: null,
      }),
    ).rejects.toBeInstanceOf(DuplicateError);
    // BigInt がそのまま戻る
    expect((await repos.agents.findById(a.tenant.id, agent.id))?.budgetMicroUsd).toBe(123n);
  });

  // 一覧はどれも `where.tenantId` の 1 行だけがテナント境界を支えている。API テストは memory アダプタで
  // 走るので prisma の where は通らず、ここで呼ばない一覧は「tenantId を外しても全件緑」になる
  // (実際 users / apiKeys / userTokens の一覧は外しても緑で、他テナントのメール・API キーが見えた)
  it('ユーザー・API キー・トークンの一覧は自テナントの行しか返さない', async () => {
    // 2 テナント (それぞれ admin と初期トークンを持つ)
    const a = await makeTenant(repos, 'ListA');
    const b = await makeTenant(repos, 'ListB');
    // A に追加のユーザー
    const extra = await repos.users.create({
      tenantId: a.tenant.id,
      email: 'member@example.com',
      name: '追加の人',
      role: Role.viewer,
    });
    // A にテナント共通の API キー (エージェントには紐づけないので null にはならない)
    const key = await repos.apiKeys.create({
      tenantId: a.tenant.id,
      agentId: null,
      prefix: 'aop_k_list',
      keyHash: 'hash-list-a',
      name: 'A のキー',
    });
    // id での取得もテナント境界の内側だけ (他テナントの id を渡しても null)。
    // ここが漏れると GET /users/{userId}/tokens の存在確認が通り、他テナントのユーザー id の実在が漏れる
    expect(await repos.users.findById(b.tenant.id, a.admin.id)).toBeNull();
    expect((await repos.users.findById(a.tenant.id, a.admin.id))?.id).toBe(a.admin.id);
    // ユーザー一覧: B から見ると B の admin だけ (A の 2 人は見えない)
    const usersOfB = await repos.users.list(b.tenant.id, { limit: 10 });
    expect(usersOfB.items.map((row) => row.id)).toEqual([b.admin.id]);
    // A から見ると A の 2 人だけ
    const usersOfA = await repos.users.list(a.tenant.id, { limit: 10 });
    expect(new Set(usersOfA.items.map((row) => row.id))).toEqual(new Set([a.admin.id, extra.id]));
    // 発行できていること (エージェントに紐づけない発行は null にならない)
    expect(key).not.toBeNull();
    // API キー一覧: B からは 0 件、A からは 1 件
    expect((await repos.apiKeys.list(b.tenant.id, { limit: 10 })).items).toHaveLength(0);
    expect(
      (await repos.apiKeys.list(a.tenant.id, { limit: 10 })).items.map((row) => row.id),
    ).toEqual([key?.id]);
    // トークン一覧: 他テナントの id を渡しても自テナントの行しか返らない (A の admin の id を B で引く)
    expect(
      (await repos.userTokens.list(b.tenant.id, a.admin.id, { limit: 10 })).items,
    ).toHaveLength(0);
    // 自テナントなら初期トークンが 1 件
    expect(
      (await repos.userTokens.list(a.tenant.id, a.admin.id, { limit: 10 })).items,
    ).toHaveLength(1);
  });

  it('API キー・ユーザートークンの複合 FK は別テナントの親を DB で拒否する (null)', async () => {
    // テナント A のエージェント、テナント B のキー発行
    const a = await makeTenant(repos, 'A');
    const b = await makeTenant(repos, 'B');
    const agent = await repos.agents.create({
      tenantId: a.tenant.id,
      name: 'bot',
      description: null,
      provider: Provider.anthropic,
      model: 'm',
      budgetMicroUsd: null,
    });
    // 別テナントのエージェントへ紐づけ → null
    expect(
      await repos.apiKeys.create({
        tenantId: b.tenant.id,
        agentId: agent.id,
        prefix: 'aop_k_x',
        keyHash: 'k1',
        name: 'x',
      }),
    ).toBeNull();
    // 同テナントなら発行できる
    const key = await repos.apiKeys.create({
      tenantId: a.tenant.id,
      agentId: agent.id,
      prefix: 'aop_k_x',
      keyHash: 'k2',
      name: 'x',
    });
    expect(key?.agentId).toBe(agent.id);
    // 別テナントのユーザーへのトークン発行 → not_found
    expect(
      await repos.userTokens.create({
        tenantId: b.tenant.id,
        userId: a.admin.id,
        prefix: 'aop_u_x',
        tokenHash: 't1',
        name: 'x',
        expiresAt: userTokenExpiresAt(TOKEN_TTL_DAYS),
      }),
    ).toEqual({ status: 'not_found' });
    // 無効化済みユーザーへの発行 → disabled (2 人目の admin を作って無効化する)
    const second = await repos.users.create({
      tenantId: a.tenant.id,
      email: 'second-token@example.com',
      name: '2',
      role: Role.admin,
    });
    const tokenInput = {
      tenantId: a.tenant.id,
      userId: second.id,
      prefix: 'aop_u_y',
      name: 'y',
      expiresAt: userTokenExpiresAt(TOKEN_TTL_DAYS),
    };
    const active = await repos.userTokens.create({ ...tokenInput, tokenHash: 't2' });
    expect(active.status).toBe('ok');
    expect(await repos.users.disable(a.tenant.id, second.id)).toMatchObject({ status: 'ok' });
    expect(await repos.userTokens.create({ ...tokenInput, tokenHash: 't3' })).toEqual({
      status: 'disabled',
    });
    // 拒否したのだから行は 1 本も増えていない (発行済みの 1 本だけ)。
    // $transaction のコールバックは正常 return でコミットするので、「挿入してから拒否を返す」書き方でも
    // 応答だけを見ていると気付けない — その場合「有効に見えるのに絶対に認証できないトークン」が DB に残る
    expect(await client.userToken.count({ where: { userId: second.id } })).toBe(1);
  });

  // 複合 FK は「アダプタのチェックを通らない書き込み」に対する第 2 の砦。アダプタ経由でしか
  // 確かめていないと、参照を単一列 FK へ弱めても全件緑のまま通る (実測)。DB へ直接書いて確かめる
  // Step2 以降で子テーブル (UsageEvent 等) の Port を足すときは、その複合 FK も同じ形でここに足す
  it('複合 FK は DB へ直接書いても別テナントの親を拒否する (アダプタを通らない経路)', async () => {
    // 2 テナント
    const a = await makeTenant(repos, 'FkA');
    const b = await makeTenant(repos, 'FkB');
    // A のエージェント
    const agent = await repos.agents.create({
      tenantId: a.tenant.id,
      name: 'fk-bot',
      description: null,
      provider: Provider.anthropic,
      model: 'claude-sonnet-4-6',
      budgetMicroUsd: null,
    });
    // B のテナントから A のエージェントを指す API キーは DB が拒否する
    await expect(
      client.apiKey.create({
        data: {
          tenantId: b.tenant.id,
          agentId: agent.id,
          prefix: 'aop_k_fk',
          keyHash: `hash-fk-${Date.now()}`,
          name: '越境キー',
        },
      }),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    // B のテナントから A のユーザーを指すトークンも同じく拒否される
    await expect(
      client.userToken.create({
        data: {
          tenantId: b.tenant.id,
          userId: a.admin.id,
          prefix: 'aop_u_fk',
          tokenHash: `hash-fk-token-${Date.now()}`,
          name: '越境トークン',
          expiresAt: userTokenExpiresAt(TOKEN_TTL_DAYS),
        },
      }),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
  });

  it('無効化済みユーザーの役割変更は昇格も降格も disabled (無効化自体は冪等なので ok)', async () => {
    // admin を 2 人にして、片方を無効化できる状態にする
    const a = await makeTenant(repos, 'A');
    const target = await repos.users.create({
      tenantId: a.tenant.id,
      email: 'disabled-role@example.com',
      name: 'd',
      role: Role.admin,
    });
    // 無効化する (1 回目は ok)
    expect((await repos.users.disable(a.tenant.id, target.id)).status).toBe('ok');
    // 昇格 (admin へ) も降格 (viewer へ) も disabled で拒否される
    expect(await repos.users.updateRole(a.tenant.id, target.id, Role.admin)).toEqual({
      status: 'disabled',
    });
    expect(await repos.users.updateRole(a.tenant.id, target.id, Role.viewer)).toEqual({
      status: 'disabled',
    });
    // 役割は書き換わっていない
    expect((await repos.users.findById(a.tenant.id, target.id))?.role).toBe(Role.admin);
    // 無効化の再実行は冪等 (disabled ではなく ok)
    expect((await repos.users.disable(a.tenant.id, target.id)).status).toBe('ok');
    // 有効なユーザーの昇格は通る (無効化の判定が昇格経路を塞いでいないこと)
    const active = await repos.users.create({
      tenantId: a.tenant.id,
      email: 'active-role@example.com',
      name: 'x',
      role: Role.viewer,
    });
    expect((await repos.users.updateRole(a.tenant.id, active.id, Role.admin)).status).toBe('ok');
    // 他テナントの id は not_found のまま (境界が disabled 判定より先)
    expect(await repos.users.updateRole('other', active.id, Role.admin)).toEqual({
      status: 'not_found',
    });
  });

  // 生 SQL のガードが「本番のクライアントに実際に配線されているか」を確かめる。
  // 単体テスト (tests/raw-sql-guard.test.ts) はガードの挙動を固定するが、結線が外れていることは見えない。
  // 実測では、綴りを走査する静的検査は `const { raw } = Prisma` の 1 段の間接化で崩れ、URL の
  // パスパラメータから任意 SQL を実行できた。値を見るこのガードが本体なので、経路ごと固定する
  it('本番のクライアントは危険な生 SQL を実行時に拒否する (トランザクション内も同じ)', async () => {
    // 値を素通しするメソッドは呼べない (クエリを組み立てる前に同期的に落ちる)
    expect(() => client.$queryRawUnsafe('SELECT 1')).toThrow(/安全でない生 SQL/);
    // SQL 断片を埋め込む形も拒否する (Prisma.raw を変数で受けても値は同じ)
    const fragment = { strings: [`1 = 1`], values: [], sql: `1 = 1` };
    expect(() => client.$queryRaw`SELECT ${fragment}`).toThrow(/安全でない生 SQL/);
    // 書き込み側も同じ (読み取りだけ見ていると、こちらを対象から外す変異が素通りする)
    expect(() => client.$executeRaw`DELETE FROM "Tenant" WHERE ${fragment}`).toThrow(
      /安全でない生 SQL/,
    );
    // トランザクション内のクライアントも同じ (行ロックを書いているのはこちら)
    await expect(
      client.$transaction(async (tx) => {
        // トランザクション内のクライアントも包まれている
        await tx.$queryRawUnsafe('SELECT 1');
      }),
    ).rejects.toThrow(/安全でない生 SQL/);
    // 拡張クライアントは作らせない。実測では拡張の中 (client / model の this) から素の実体が漏れ、
    // しかも「Composition Root で createPrismaRepos(prisma.$extends(...)) に差し替える」という
    // 自然な運用改善の形で入りうるので、データ層全体が黙って無防備になる
    expect(() =>
      (client as unknown as { $extends: (options: object) => unknown }).$extends({}),
    ).toThrow(/安全でない生 SQL/);
    // クライアントを辿れるオブジェクトから 1 ホップで外へ出られないこと。
    // モデルデリゲート (prisma.tenant / tx.user) にも $parent が生えており、実測ではそこから
    // ガードを通らない生 SQL に到達できた (アダプタは全メソッドでデリゲートを触るので本命の経路)
    expect(() =>
      (client.tenant as unknown as { $parent: typeof client }).$parent.$queryRawUnsafe('SELECT 1'),
    ).toThrow(/安全でない生 SQL/);
    await expect(
      client.$transaction(async (tx) => {
        // tx から親クライアントを辿る
        await (tx as unknown as { $parent: typeof client }).$parent.$queryRawUnsafe('SELECT 1');
      }),
    ).rejects.toThrow(/安全でない生 SQL/);
    await expect(
      client.$transaction(async (tx) => {
        // tx のモデルデリゲートから親クライアントを辿る
        await (tx.user as unknown as { $parent: typeof client }).$parent.$queryRawUnsafe(
          'SELECT 1',
        );
      }),
    ).rejects.toThrow(/安全でない生 SQL/);
    // 内部用の入口 (危険な名前を列挙する形では漏れる綴り) も塞がっていること
    expect(() =>
      (
        client as unknown as { $queryRawInternal: (...args: unknown[]) => unknown }
      ).$queryRawInternal(undefined, '$queryRawUnsafe', ['SELECT 1']),
    ).toThrow(/安全でない生 SQL/);
    // 正しい形 (値を埋め込んだタグ付きテンプレート) は通る
    expect(await client.$queryRaw`SELECT ${1}::int AS value`).toEqual([{ value: 1 }]);
  });

  // 更新側と対になる作成側の表明。writer を外して入力を丸ごと渡す形へ戻すと、呼び出し側が行 id や
  // 初期状態・無効化日時・失効日時まで決められる (実測でそこまで到達した)。値の往復だけを見ていると
  // この巻き戻しは全件緑のまま通るので、「余分な項目が届かないこと」を別に固定する
  it('作成は許した項目だけを書き、余分な項目は DB へ届かない', async () => {
    // テナントを 1 つ
    const a = await makeTenant(repos, 'CreateExtra');
    const tenantId = a.tenant.id;
    // 型の上では渡せない項目を混ぜてユーザーを作る (Port の型を迂回した呼び出しを再現する)
    const user = await repos.users.create({
      tenantId,
      email: 'create-extra@example.com',
      name: '余分',
      role: Role.viewer,
      id: 'attacker-chosen-user',
      disabledAt: new Date(),
    } as never);
    // 行 id は DB が決め、無効化済みでは作られないこと
    expect(user.id).not.toBe('attacker-chosen-user');
    expect(user.disabledAt).toBeNull();
    // エージェントも同じ (状態を suspended で作らせない)
    const agent = await repos.agents.create({
      tenantId,
      name: 'create-extra-bot',
      description: null,
      provider: Provider.anthropic,
      model: 'claude-sonnet-4-6',
      budgetMicroUsd: null,
      id: 'attacker-chosen-agent',
      status: AgentStatus.suspended,
    } as never);
    expect(agent.id).not.toBe('attacker-chosen-agent');
    expect(agent.status).toBe(AgentStatus.active);
    // API キーも同じ (最初から失効済みのキーを作らせない)
    const key = await repos.apiKeys.create({
      tenantId,
      agentId: null,
      prefix: 'aop_k_extra',
      keyHash: `hash-create-extra-${Date.now()}`,
      name: '余分キー',
      id: 'attacker-chosen-key',
      revokedAt: new Date(),
    } as never);
    expect(key?.id).not.toBe('attacker-chosen-key');
    expect(key?.revokedAt).toBeNull();
    // ログイントークンも同じ (最初から失効済みのトークンを作らせない)
    const issued = await repos.userTokens.create({
      tenantId,
      userId: user.id,
      prefix: 'aop_u_extra',
      tokenHash: `hash-create-extra-token-${Date.now()}`,
      name: '余分トークン',
      expiresAt: userTokenExpiresAt(TOKEN_TTL_DAYS),
      id: 'attacker-chosen-token',
      revokedAt: new Date(),
    } as never);
    expect(issued.status).toBe('ok');
    if (issued.status !== 'ok') return;
    expect(issued.token.id).not.toBe('attacker-chosen-token');
    expect(issued.token.revokedAt).toBeNull();
  });

  // 更新は「更新してよい項目」だけを DB へ渡す。検証済みの本文を丸ごと渡す実装だと、
  // 契約と Zod に項目が増えた瞬間に status や tenantId まで届く (実測で権限の迂回とテナント移動に到達した)。
  // memory アダプタは項目ごとに代入するのでこの差は API テストからは見えない
  it('更新は許した項目だけを書き、余分な項目は DB へ届かない', async () => {
    // 2 テナントと A のエージェント
    const a = await makeTenant(repos, 'PatchA');
    const b = await makeTenant(repos, 'PatchB');
    const agent = await repos.agents.create({
      tenantId: a.tenant.id,
      name: 'patch-bot',
      description: null,
      provider: Provider.anthropic,
      model: 'claude-sonnet-4-6',
      budgetMicroUsd: null,
    });
    // 型の上では渡せない項目を混ぜて更新する (Port の型を迂回した呼び出しを再現する)
    const updated = await repos.agents.update(a.tenant.id, agent.id, {
      name: 'patch-bot-2',
      status: AgentStatus.stopped,
      tenantId: b.tenant.id,
      provider: Provider.openai,
    } as never);
    // 名前だけが変わり、状態・テナント・提供元は変わらないこと
    expect(updated?.name).toBe('patch-bot-2');
    expect(updated?.status).toBe(AgentStatus.active);
    expect(updated?.tenantId).toBe(a.tenant.id);
    expect(updated?.provider).toBe(Provider.anthropic);
    // 許した項目は逆に「必ず届く」こと。手で並べた一覧から 1 つ落ちても 200 のまま黙って
    // 無視されるだけなので、往復させて確かめる (説明・予算は null 戻しも見る)
    const applied = await repos.agents.update(a.tenant.id, agent.id, {
      description: '新しい説明',
      model: 'claude-opus-4-1',
      budgetMicroUsd: 42n,
    });
    expect(applied?.description).toBe('新しい説明');
    expect(applied?.model).toBe('claude-opus-4-1');
    expect(applied?.budgetMicroUsd).toBe(42n);
    // null で未設定へ戻せること
    const cleared = await repos.agents.update(a.tenant.id, agent.id, {
      description: null,
      budgetMicroUsd: null,
    });
    expect(cleared?.description).toBeNull();
    expect(cleared?.budgetMicroUsd).toBeNull();
    // 指定しなかった項目は保たれること
    expect(cleared?.model).toBe('claude-opus-4-1');
  });

  it('同テナント内の改名で名前が重複すると DuplicateError (更新経路の一意制約)', async () => {
    // 1 テナントに 2 体のエージェント
    const a = await makeTenant(repos, 'A');
    const base = {
      tenantId: a.tenant.id,
      description: null,
      provider: Provider.anthropic,
      model: 'm',
      budgetMicroUsd: null,
    };
    const first = await repos.agents.create({ ...base, name: '一号機' });
    const second = await repos.agents.create({ ...base, name: '二号機' });
    // 既存の名前へ改名すると一意制約違反 (作成経路と同じ型へ翻訳される)
    await expect(
      repos.agents.update(a.tenant.id, second.id, { name: first.name }),
    ).rejects.toBeInstanceOf(DuplicateError);
    // 自分自身の名前への改名は通る (冪等)
    expect((await repos.agents.update(a.tenant.id, second.id, { name: second.name }))?.name).toBe(
      second.name,
    );
  });

  it('失効はテナント・ユーザー境界の内側だけで効き、二度目は日時を保つ (漏れた資格情報のキルスイッチ)', async () => {
    // 2 テナント (A のトークン・キーを B から失効できないこと確かめる)
    const a = await makeTenant(repos, 'A');
    const b = await makeTenant(repos, 'B');
    // A の 2 人目のユーザー (トークンの発行先違いを確かめる)
    const other = await repos.users.create({
      tenantId: a.tenant.id,
      email: 'other-revoke@example.com',
      name: 'o',
      role: Role.operator,
    });
    // A の admin にトークンを 1 本発行する
    const issued = await repos.userTokens.create({
      tenantId: a.tenant.id,
      userId: a.admin.id,
      prefix: 'aop_u_r',
      tokenHash: `hash-revoke-${Date.now()}`,
      name: 'r',
      expiresAt: userTokenExpiresAt(TOKEN_TTL_DAYS),
    });
    expect(issued.status).toBe('ok');
    if (issued.status !== 'ok') return;
    // 境界の外からの失効は null を返すだけでなく、行を書き換えてもいけない (戻り値は読み直し側の条件でも null に
    // なるため、実際に失効していないことを別途確かめる — さもないと更新側の条件漏れを見逃す)
    const stillActive = async () =>
      (await repos.userTokens.findByHash(issued.token.tokenHash))?.token.revokedAt ?? null;
    // 別テナントからは失効できない (null)
    expect(await repos.userTokens.revoke(b.tenant.id, a.admin.id, issued.token.id)).toBeNull();
    expect(await stillActive()).toBeNull();
    // 同テナントでも発行先が違えば失効できない (userId の条件が効いていること)
    expect(await repos.userTokens.revoke(a.tenant.id, other.id, issued.token.id)).toBeNull();
    expect(await stillActive()).toBeNull();
    // 正しい組み合わせなら失効する
    const revoked = await repos.userTokens.revoke(a.tenant.id, a.admin.id, issued.token.id);
    expect(revoked?.revokedAt).not.toBeNull();
    // 二度目は日時を保つ (冪等)
    const again = await repos.userTokens.revoke(a.tenant.id, a.admin.id, issued.token.id);
    expect(again?.revokedAt?.getTime()).toBe(revoked?.revokedAt?.getTime());
    // 失効したトークンはハッシュで引けても revokedAt が入る (認証側が 401 にする材料)
    expect(
      (await repos.userTokens.findByHash(issued.token.tokenHash))?.token.revokedAt,
    ).not.toBeNull();
    // API キーも同じ規則 (テナント共通キーで確かめる)
    const key = await repos.apiKeys.create({
      tenantId: a.tenant.id,
      agentId: null,
      prefix: 'aop_k_r',
      keyHash: `key-revoke-${Date.now()}`,
      name: 'r',
    });
    expect(key).not.toBeNull();
    if (!key) return;
    // 別テナントからは失効できない (行も書き換わらない)
    expect(await repos.apiKeys.revoke(b.tenant.id, key.id)).toBeNull();
    expect((await repos.apiKeys.findById(a.tenant.id, key.id))?.revokedAt).toBeNull();
    // 正しいテナントなら失効し、二度目も日時を保つ
    const revokedKey = await repos.apiKeys.revoke(a.tenant.id, key.id);
    expect(revokedKey?.revokedAt).not.toBeNull();
    const againKey = await repos.apiKeys.revoke(a.tenant.id, key.id);
    expect(againKey?.revokedAt?.getTime()).toBe(revokedKey?.revokedAt?.getTime());
  });

  it('履歴 (UsageEvent) を持つエージェントは削除できず、履歴が無ければ専用キーごと消える', async () => {
    // エージェント + 専用キー
    const a = await makeTenant(repos, 'A');
    const agent = await repos.agents.create({
      tenantId: a.tenant.id,
      name: 'bot',
      description: null,
      provider: Provider.anthropic,
      model: 'm',
      budgetMicroUsd: null,
    });
    const key = await repos.apiKeys.create({
      tenantId: a.tenant.id,
      agentId: agent.id,
      prefix: 'aop_k_x',
      keyHash: 'k3',
      name: 'x',
    });
    // 利用イベントを 1 件入れる (Restrict)
    await client.usageEvent.create({
      data: {
        tenantId: a.tenant.id,
        agentId: agent.id,
        provider: Provider.anthropic,
        model: 'm',
        inputTokens: 1,
        outputTokens: 1,
        costMicroUsd: 1n,
        latencyMs: 1,
        statusCode: 200,
      },
    });
    // 削除は拒否される
    expect(await repos.agents.delete(a.tenant.id, agent.id)).toBe('restricted');
    // 履歴を消してから削除すると、専用キーも Cascade で消える
    await client.usageEvent.deleteMany({ where: { agentId: agent.id } });
    expect(await repos.agents.delete(a.tenant.id, agent.id)).toBe('deleted');
    expect(await repos.apiKeys.findById(a.tenant.id, key!.id)).toBeNull();
  });

  it('一覧は createdAt → id 順で、nextCursor は最終行の位置を符号化した値、末尾より後ろの位置は空', async () => {
    // 3 件
    const a = await makeTenant(repos, 'A');
    for (const name of ['x', 'y', 'z']) {
      await repos.agents.create({
        tenantId: a.tenant.id,
        name,
        description: null,
        provider: Provider.anthropic,
        model: 'm',
        budgetMicroUsd: null,
      });
    }
    // 2 件ずつ
    const p1 = await repos.agents.list(a.tenant.id, { limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(decodeCursor(p1.nextCursor!)).toEqual({
      createdAt: p1.items[1].createdAt,
      id: p1.items[1].id,
    });
    const p2 = await repos.agents.list(a.tenant.id, {
      limit: 2,
      cursor: decodeCursor(p1.nextCursor!)!,
    });
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeUndefined();
    // 重複無し・作成順
    const names = [...p1.items, ...p2.items].map((r) => r.name);
    expect(names).toEqual(['x', 'y', 'z']);
    // 末尾より後ろの位置 (未来の時刻) をカーソルにすると空ページ
    const beyond = { createdAt: new Date(Date.now() + 60_000), id: 'zzz' };
    expect((await repos.agents.list(a.tenant.id, { limit: 2, cursor: beyond })).items).toHaveLength(
      0,
    );
  });

  it('最後の有効な admin の降格・無効化は last_admin で拒否し、無効化は冪等', async () => {
    // admin 1 人
    const a = await makeTenant(repos, 'A');
    // 唯一の admin は降格も無効化もできない
    expect(await repos.users.updateRole(a.tenant.id, a.admin.id, Role.viewer)).toEqual({
      status: 'last_admin',
    });
    expect(await repos.users.disable(a.tenant.id, a.admin.id)).toEqual({ status: 'last_admin' });
    // admin のまま (役割の再設定) は通る
    expect((await repos.users.updateRole(a.tenant.id, a.admin.id, Role.admin)).status).toBe('ok');
    // admin への昇格 (ロック無しの経路) でもテナント境界外は not_found
    expect(await repos.users.updateRole('other', a.admin.id, Role.admin)).toEqual({
      status: 'not_found',
    });
    // 2 人目の admin を足すと、片方を無効化できる
    const second = await repos.users.create({
      tenantId: a.tenant.id,
      email: 'second@example.com',
      name: '2',
      role: Role.admin,
    });
    const once = await repos.users.disable(a.tenant.id, second.id);
    const twice = await repos.users.disable(a.tenant.id, second.id);
    expect(once.status).toBe('ok');
    expect(twice.status).toBe('ok');
    if (once.status === 'ok' && twice.status === 'ok') {
      // 冪等 (最初の日時を保つ)
      expect(once.user.disabledAt).not.toBeNull();
      expect(twice.user.disabledAt?.getTime()).toBe(once.user.disabledAt?.getTime());
      // 2 回目は何も書き換えない (updatedAt も進まない。memory アダプタと同じ契約)
      expect(twice.user.updatedAt.getTime()).toBe(once.user.updatedAt.getTime());
    }
    // 残った admin はまた最後の 1 人
    expect(await repos.users.disable(a.tenant.id, a.admin.id)).toEqual({ status: 'last_admin' });
    // 他テナントからは触れない
    expect(await repos.users.disable('other', second.id)).toEqual({ status: 'not_found' });
    expect(await repos.users.findByEmail(a.tenant.id, 'second@example.com')).not.toBeNull();
    expect(await repos.users.findByEmail('other', 'second@example.com')).toBeNull();
  });

  // 上のテストは 2 本の要求が実際には直列に流れるため、ロック句を落としても緑のまま通ってしまう
  // (実測)。そこで「同じテナント行を別のトランザクションが掴んでいる間、降格が待たされる」ことを
  // 決定的に確かめる — ロックが無ければ待たずに終わるので、ロック句の削除がここで赤くなる
  it('同じテナント行を掴んでいる間、降格は待たされる (テナント行ロックの存在)', async () => {
    // admin 2 人 (降格そのものが last_admin で弾かれないようにする)
    const a = await makeTenant(repos, 'HeldLock');
    const second = await repos.users.create({
      tenantId: a.tenant.id,
      email: 'second@example.com',
      name: '2 人目の管理者',
      role: Role.admin,
    });
    // ロックを離す合図
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    // ロックを掴んだ合図 (掴む前に降格を始めると、どちらが先に行を取るかは数ミリ秒の運になり
    // 「待たされなかった」という誤った赤が出る。実測で 400 回中 17 回まで落ちた)
    let signalHeld = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    // 別のトランザクションでテナント行を掴んだまま待つ
    const holding = client.$transaction(
      async (tx) => {
        // 降格が取るのと同じ行・同じ強さのロック
        await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${a.tenant.id} FOR NO KEY UPDATE`;
        // 掴めたことを知らせる
        signalHeld();
        // 合図が来るまで保持する
        await released;
      },
      { timeout: LOCK_TEST_TRANSACTION_TIMEOUT_MS },
    );
    // 掴むまで降格を始めない
    await held;
    // 降格を始める (ロックが効いていれば、掴んでいる間は終わらない)
    const demote = repos.users.updateRole(a.tenant.id, second.id, Role.viewer);
    try {
      // 待たされていること (先に時間切れの方が返る)
      const finishedFirst = await Promise.race([
        demote.then(() => 'demoted' as const),
        new Promise<'blocked'>((resolve) =>
          setTimeout(() => resolve('blocked'), LOCK_TEST_WAIT_MS),
        ),
      ]);
      expect(finishedFirst).toBe('blocked');
    } finally {
      // 失敗しても必ず離す (掴んだまま抜けると、次のテストの TRUNCATE が待たされて道連れで落ちる)
      release();
      await holding;
    }
    // ロックを離した後は降格が通る
    expect((await demote).status).toBe('ok');
  });

  // 対象ユーザーの行ロック (lockActiveUser) にも同じ形の検査を置く。テナント行のロックだけを見ていると、
  // こちらのロック句を落としても全件緑のまま通る (実測)。外れると「無効化の直前の姿」でトークンを発行できる
  // 対象ユーザーの行を別トランザクションで掴んだまま操作を始め、待たされることを確かめる。
  // lockActiveUser を呼ぶ 3 経路 (トークン発行・admin への昇格・降格/無効化) で同じ形を使う —
  // 1 経路だけ見ていると、他の呼び出しからロックを外しても全件緑のまま通る (実測)
  async function expectBlockedWhileUserRowLocked<T>(
    tenantId: string,
    userId: string,
    start: () => Promise<T>,
  ): Promise<T> {
    // ロックを離す合図
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    // ロックを掴んだ合図 (掴む前に操作を始めると順序が数ミリ秒の運になる)
    let signalHeld = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    // 別のトランザクションで対象ユーザーの行を掴んだまま待つ
    const holding = client.$transaction(
      async (tx) => {
        // 操作が取るのと同じ行・同じ強さのロック
        await tx.$queryRaw`SELECT "disabledAt" FROM "User" WHERE "tenantId" = ${tenantId} AND id = ${userId} FOR NO KEY UPDATE`;
        // 掴めたことを知らせる
        signalHeld();
        // 合図が来るまで保持する
        await released;
      },
      { timeout: LOCK_TEST_TRANSACTION_TIMEOUT_MS },
    );
    // 掴むまで操作を始めない
    await held;
    // 操作を始める (ロックが効いていれば、掴んでいる間は終わらない)
    const running = start();
    try {
      // 待たされていること (先に時間切れの方が返る)
      const finishedFirst = await Promise.race([
        running.then(() => 'finished' as const),
        new Promise<'blocked'>((resolve) =>
          setTimeout(() => resolve('blocked'), LOCK_TEST_WAIT_MS),
        ),
      ]);
      expect(finishedFirst).toBe('blocked');
    } finally {
      // 失敗しても必ず離す (掴んだまま抜けると、次のテストの TRUNCATE が待たされて道連れで落ちる)
      release();
      await holding;
    }
    // ロックを離した後の結果を返す
    return running;
  }

  // 「待たされる」だけでは足りない経路のための形。役割変更は最後に UPDATE を投げるので、
  // ロックを外しても UPDATE 自体が待たされ、「待たされた」という観察では原本と区別が付かない (実測)。
  // そこで待っている間に無効化をコミットし、**待ち終わったあとに読み直しているか**で見分ける。
  // ロックを取っていれば読み直して 'disabled'、取っていなければ古い姿のまま 'ok' を返して
  // 無効化済みの行に役割を書き込む (コードのコメントが避けると宣言している状態)
  async function expectSeesDisableCommittedWhileWaiting<T>(
    tenantId: string,
    userId: string,
    start: () => Promise<T>,
  ): Promise<T> {
    // 無効化してロックを離す合図
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    // ロックを掴んだ合図
    let signalHeld = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    // 対象ユーザーの行を掴み、合図が来たら無効化してコミットする
    const holding = client.$transaction(
      async (tx) => {
        // 操作が取るのと同じ行・同じ強さのロック
        await tx.$queryRaw`SELECT "disabledAt" FROM "User" WHERE "tenantId" = ${tenantId} AND id = ${userId} FOR NO KEY UPDATE`;
        // 掴めたことを知らせる
        signalHeld();
        // 合図が来るまで保持する
        await released;
        // 待っている相手に見えるべき変更 (無効化) を書いてからコミットする
        await tx.user.update({
          where: { tenantId_id: { tenantId, id: userId } },
          data: { disabledAt: new Date() },
        });
      },
      { timeout: LOCK_TEST_TRANSACTION_TIMEOUT_MS },
    );
    // 掴むまで操作を始めない
    await held;
    // 操作を始める
    const running = start();
    try {
      // 先に始まっていること (時間切れの方が先に返る = まだ終わっていない)
      const finishedFirst = await Promise.race([
        running.then(() => 'finished' as const),
        new Promise<'blocked'>((resolve) =>
          setTimeout(() => resolve('blocked'), LOCK_TEST_WAIT_MS),
        ),
      ]);
      expect(finishedFirst).toBe('blocked');
    } finally {
      // 無効化を書いてコミットさせる (失敗しても必ず離す)
      release();
      await holding;
    }
    // コミット後の結果を返す
    return running;
  }

  it('同じユーザー行を掴んでいる間、トークン発行は待たされる (ユーザー行ロックの存在)', async () => {
    // 発行先のユーザー (テナントの admin)
    const a = await makeTenant(repos, 'HeldUserLock');
    // ロックを掴んだまま発行を始める
    const issued = await expectBlockedWhileUserRowLocked(a.tenant.id, a.admin.id, () =>
      repos.userTokens.create({
        tenantId: a.tenant.id,
        userId: a.admin.id,
        prefix: 'aop_u_lock',
        tokenHash: `hash-userlock-${Date.now()}`,
        name: 'ロックの検査',
        expiresAt: userTokenExpiresAt(TOKEN_TTL_DAYS),
      }),
    );
    // ロックを離した後は発行できる
    expect(issued.status).toBe('ok');
  });

  it('昇格は待っている間にコミットされた無効化を見る (昇格経路の行ロック)', async () => {
    // 昇格させる相手 (viewer)
    const a = await makeTenant(repos, 'HeldPromote');
    const target = await repos.users.create({
      tenantId: a.tenant.id,
      email: 'promote@example.com',
      name: '昇格する人',
      role: Role.viewer,
    });
    // ロックを掴んだまま昇格を始め、待っている間に無効化をコミットする
    const promoted = await expectSeesDisableCommittedWhileWaiting(a.tenant.id, target.id, () =>
      repos.users.updateRole(a.tenant.id, target.id, Role.admin),
    );
    // 読み直していれば無効化が見えて拒否される (認証できない admin を作らない)
    expect(promoted.status).toBe('disabled');
  });

  it('降格は待っている間にコミットされた無効化を見る (降格経路の対象行ロック)', async () => {
    // 降格させる相手 (2 人目の admin。last_admin で弾かれないようにする)
    const a = await makeTenant(repos, 'HeldDemote');
    const target = await repos.users.create({
      tenantId: a.tenant.id,
      email: 'demote@example.com',
      name: '降格する人',
      role: Role.admin,
    });
    // ロックを掴んだまま降格を始め、待っている間に無効化をコミットする
    const demoted = await expectSeesDisableCommittedWhileWaiting(a.tenant.id, target.id, () =>
      repos.users.updateRole(a.tenant.id, target.id, Role.viewer),
    );
    // 読み直していれば無効化が見えて拒否される (無効化済みユーザーの役割変更は disabled)
    expect(demoted.status).toBe('disabled');
  });

  // ロックは「弱すぎないか」だけでなく「強すぎないか」も不変条件。FOR UPDATE へ強めると、
  // 子テーブルの INSERT が親行に取る FK 検査のロック (FOR KEY SHARE) と衝突して本物のデッドロックになる。
  // 外す変異は既存のテストが落とすが、強める変異は全件緑のまま通っていた (実測)
  it('ロックは子テーブルの FK 検査と衝突しない (FOR UPDATE へ強めていない)', async () => {
    // 降格させる相手 (2 人目の admin)
    const a = await makeTenant(repos, 'KeyShare');
    const second = await repos.users.create({
      tenantId: a.tenant.id,
      email: 'keyshare@example.com',
      name: '2 人目の管理者',
      role: Role.admin,
    });
    // ロックを離す合図
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    // ロックを掴んだ合図
    let signalHeld = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    // 子テーブルの INSERT が親行に取るのと同じ弱いロックを掴んだまま待つ
    const holding = client.$transaction(
      async (tx) => {
        // テナント行とユーザー行の両方 (役割変更はテナント行を、トークン発行はユーザー行を取る)
        await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${a.tenant.id} FOR KEY SHARE`;
        await tx.$queryRaw`SELECT id FROM "User" WHERE "tenantId" = ${a.tenant.id} AND id = ${a.admin.id} FOR KEY SHARE`;
        // 掴めたことを知らせる
        signalHeld();
        // 合図が来るまで保持する
        await released;
      },
      { timeout: LOCK_TEST_TRANSACTION_TIMEOUT_MS },
    );
    // 掴むまで始めない
    await held;
    // 掴まれたままでも両方とも進めること (強いロックなら待たされる)
    const running = Promise.all([
      repos.users.updateRole(a.tenant.id, second.id, Role.viewer),
      repos.userTokens.create({
        tenantId: a.tenant.id,
        userId: a.admin.id,
        prefix: 'aop_u_ks',
        tokenHash: `hash-keyshare-${Date.now()}`,
        name: '弱いロックの検査',
        expiresAt: userTokenExpiresAt(TOKEN_TTL_DAYS),
      }),
    ]);
    try {
      // 待たされずに終わること
      const finishedFirst = await Promise.race([
        running.then(() => 'finished' as const),
        new Promise<'blocked'>((resolve) =>
          setTimeout(() => resolve('blocked'), LOCK_TEST_WAIT_MS),
        ),
      ]);
      expect(finishedFirst).toBe('finished');
    } finally {
      // 失敗しても必ず離す
      release();
      await holding;
    }
    // どちらも成功していること
    expect((await running).map((result) => result.status)).toEqual(['ok', 'ok']);
  });

  // 同じ不変条件をエージェント行のロックにも掛ける。API キー発行は紐づけ先のエージェント行を
  // FOR KEY SHARE で押さえる (削除だけを待たせ、状態変更や他のキー発行は妨げない)。
  // FOR UPDATE へ強めても全件緑のまま通っていた (実測。実 DB では子テーブルの INSERT が 2 秒待たされた)。
  // Step2 で UsageEvent が同じ親を参照すると、キー発行 1 本がそのエージェントの全トラフィックを止める
  it('エージェント行のロックも子テーブルの FK 検査と衝突しない (FOR UPDATE へ強めていない)', async () => {
    // 紐づけ先のエージェント
    const a = await makeTenant(repos, 'AgentKeyShare');
    const agent = await repos.agents.create({
      tenantId: a.tenant.id,
      name: 'keyshare-bot',
      description: null,
      provider: Provider.anthropic,
      model: 'claude-sonnet-4-6',
      budgetMicroUsd: null,
    });
    // ロックを離す合図
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    // ロックを掴んだ合図
    let signalHeld = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    // 子テーブルの INSERT が親行に取るのと同じ弱いロックを掴んだまま待つ
    const holding = client.$transaction(
      async (tx) => {
        // エージェント行を弱いロックで掴む
        await tx.$queryRaw`SELECT id FROM "Agent" WHERE "tenantId" = ${a.tenant.id} AND id = ${agent.id} FOR KEY SHARE`;
        // 掴めたことを知らせる
        signalHeld();
        // 合図が来るまで保持する
        await released;
      },
      { timeout: LOCK_TEST_TRANSACTION_TIMEOUT_MS },
    );
    // 掴むまで始めない
    await held;
    // 掴まれたままでも発行が進むこと (強いロックなら待たされる)
    const running = repos.apiKeys.create({
      tenantId: a.tenant.id,
      agentId: agent.id,
      prefix: 'aop_k_ks',
      keyHash: `hash-agent-keyshare-${Date.now()}`,
      name: '弱いロックの検査',
    });
    try {
      // 待たされずに終わること
      const finishedFirst = await Promise.race([
        running.then(() => 'finished' as const),
        new Promise<'blocked'>((resolve) =>
          setTimeout(() => resolve('blocked'), LOCK_TEST_WAIT_MS),
        ),
      ]);
      expect(finishedFirst).toBe('finished');
    } finally {
      // 失敗しても必ず離す
      release();
      await holding;
    }
    // 発行できていること
    expect((await running)?.agentId).toBe(agent.id);
  });

  it('並行する降格要求でも有効な admin が 0 人にならない (行ロックで直列化)', async () => {
    // admin 2 人 (X, Y)
    const a = await makeTenant(repos, 'A');
    const y = await repos.users.create({
      tenantId: a.tenant.id,
      email: 'y@example.com',
      name: 'Y',
      role: Role.admin,
    });
    // 互いを同時に降格する
    const results = await Promise.all([
      repos.users.updateRole(a.tenant.id, a.admin.id, Role.viewer),
      repos.users.updateRole(a.tenant.id, y.id, Role.viewer),
    ]);
    // 片方は ok、片方は last_admin
    expect(results.map((r) => r.status).sort()).toEqual(['last_admin', 'ok']);
    // 有効な admin が 1 人残っている
    const remaining = await client.user.count({
      where: { tenantId: a.tenant.id, role: Role.admin, disabledAt: null },
    });
    expect(remaining).toBe(1);
  });

  it('カーソルは位置 (createdAt, id) なので、他テナントの行や削除済みの行の位置でも自テナントの続きが正しく取れる', async () => {
    // テナント A に 3 件 (a1 → a2 → a3 の順)、その間にテナント B に 1 件
    const a = await makeTenant(repos, 'A');
    const b = await makeTenant(repos, 'B');
    const mk = (tenantId: string, name: string) =>
      repos.agents.create({
        tenantId,
        name,
        description: null,
        provider: Provider.anthropic,
        model: 'm',
        budgetMicroUsd: null,
      });
    const a1 = await mk(a.tenant.id, 'a1');
    const other = await mk(b.tenant.id, 'b1');
    const a2 = await mk(a.tenant.id, 'a2');
    const a3 = await mk(a.tenant.id, 'a3');
    // 他テナントの行の位置をカーソルにしても、その位置より後ろの自テナントの行 (a2, a3) が 1 件も飛ばずに返る
    const afterOther = await repos.agents.list(a.tenant.id, {
      limit: 10,
      cursor: { createdAt: other.createdAt, id: other.id },
    });
    expect(afterOther.items.map((r) => r.id)).toEqual([a2.id, a3.id]);
    // カーソル行 (a1) を削除しても、そのカーソルで続きが取れる
    const p1 = await repos.agents.list(a.tenant.id, { limit: 1 });
    expect(p1.items[0].id).toBe(a1.id);
    expect(await repos.agents.delete(a.tenant.id, a1.id)).toBe('deleted');
    const p2 = await repos.agents.list(a.tenant.id, {
      limit: 10,
      cursor: decodeCursor(p1.nextCursor!)!,
    });
    expect(p2.items.map((r) => r.id)).toEqual([a2.id, a3.id]);
    // 絞り込み (status) とカーソルの併用: stopped の a2 を除いた続き
    await repos.agents.setStatus(a.tenant.id, a2.id, 'stopped');
    const activeAfter = await repos.agents.list(
      a.tenant.id,
      { limit: 10, cursor: decodeCursor(p1.nextCursor!)! },
      { status: 'active' },
    );
    expect(activeAfter.items.map((r) => r.id)).toEqual([a3.id]);
  });
  // 作成系は「項目の過不足」を型で固定しているが、各項目の値の配線は型では表せない。
  // API テストは memory アダプタで走るので、prisma 側の 1 行を書き換えても本番だけが壊れる
  it('作成した行は入力どおりの値で保存される (テナント・ユーザー・トークン・エージェント・API キー)', async () => {
    // テナント (最初の admin とブートストラップトークンも同時に作る)
    const bootstrapToken = {
      prefix: 'aop_u_boot',
      tokenHash: `hash-roundtrip-${Date.now()}`,
      name: 'ブートストラップ',
      expiresAt: userTokenExpiresAt(TOKEN_TTL_DAYS),
    };
    const created = await repos.tenants.createWithAdmin({
      name: '往復テナント',
      admin: { email: 'roundtrip-admin@example.com', name: '往復管理者' },
      token: bootstrapToken,
    });
    const tenantId = created.tenant.id;
    // テナントの表示名とプラン (プランは入力で決めさせず free 固定)
    expect(await repos.tenants.findById(tenantId)).toMatchObject({
      name: '往復テナント',
      plan: Plan.free,
    });
    // 最初の admin (役割は必ず admin)
    expectStoredAsGiven(created.admin, {
      tenantId,
      email: 'roundtrip-admin@example.com',
      name: '往復管理者',
      role: Role.admin,
    });
    // ブートストラップトークンは全項目そのまま
    const bootstrapStored = await repos.userTokens.findByHash(bootstrapToken.tokenHash);
    expectStoredAsGiven(bootstrapStored!.token, {
      tenantId,
      userId: created.admin.id,
      ...bootstrapToken,
    });

    // 招待したユーザー (既定値と区別できるよう admin 以外の役割にする)
    const userInput = {
      tenantId,
      email: 'roundtrip-user@example.com',
      name: '往復ユーザー',
      role: Role.operator,
    };
    const user = await repos.users.create(userInput);
    // 作成の戻り値と、読み直した行の両方で確かめる (戻り値だけだと「応答は正しいが DB は違う」を見逃す)
    expectStoredAsGiven(user, userInput);
    expectStoredAsGiven((await repos.users.findById(tenantId, user.id))!, userInput);

    // 発行したトークン (有効期限・接頭辞・用途名がそのまま入っていること)
    const tokenInput = {
      tenantId,
      userId: user.id,
      prefix: 'aop_u_round',
      tokenHash: `hash-roundtrip-user-${Date.now()}`,
      name: '往復トークン',
      expiresAt: userTokenExpiresAt(TOKEN_TTL_DAYS),
    };
    const issued = await repos.userTokens.create(tokenInput);
    expect(issued.status).toBe('ok');
    expectStoredAsGiven(
      (await repos.userTokens.findByHash(tokenInput.tokenHash))!.token,
      tokenInput,
    );

    // エージェント (説明と予算は null と区別できる値にする)
    const agentInput = {
      tenantId,
      name: '往復エージェント',
      description: '往復の説明',
      provider: Provider.openai,
      model: 'gpt-往復',
      budgetMicroUsd: 1_234n,
    };
    const agent = await repos.agents.create(agentInput);
    expectStoredAsGiven(agent, agentInput);
    expectStoredAsGiven((await repos.agents.findById(tenantId, agent.id))!, agentInput);
    // 状態は入力で決めさせず既定の active から始まる
    expect(agent.status).toBe(AgentStatus.active);

    // API キー (エージェント紐づけ・接頭辞・用途名)
    const keyInput = {
      tenantId,
      agentId: agent.id,
      prefix: 'aop_k_round',
      keyHash: `hash-roundtrip-key-${Date.now()}`,
      name: '往復キー',
    };
    const key = await repos.apiKeys.create(keyInput);
    expectStoredAsGiven(key!, keyInput);
    expectStoredAsGiven((await repos.apiKeys.findById(tenantId, key!.id))!, keyInput);
    // 失効日時は発行時には入らない
    expect(key!.revokedAt).toBeNull();
  });
});
