// ダッシュボードのセッション (Step5 / ADR-0011) の検査。
// Cookie の属性と「どのトークンを未ログインとして扱うか」を固定する。
import { describe, expect, it } from 'vitest';
import { createMemoryRepos, MemoryStore } from '@/data/adapters/memory';
import type { Repositories } from '@/data/ports';
import { USER_TOKEN_DEFAULT_TTL_DAYS } from '@/lib/constants';
import {
  SESSION_COOKIE_MAX_AGE_SECONDS,
  clearedSessionCookieOptions,
  resolveSessionPrincipal,
  sessionCookieOptions,
} from '@/lib/session';
import { generateSecret, hashSecret } from '@/lib/tokens';

// 1 日の秒数 (Cookie の寿命をトークンの既定有効期限と比べるのに使う)
const SECONDS_PER_DAY = 24 * 60 * 60;

// テスト用のテナントと有効なユーザートークンを 1 組作る
async function setupTenant(): Promise<{
  repos: Repositories;
  tenantId: string;
  adminToken: string;
}> {
  // 毎回新しい表で組み立てる
  const repos = createMemoryRepos(new MemoryStore());
  // 平文のトークンを作る (リポジトリにはハッシュだけを渡す)
  const adminToken = generateSecret('user');
  // テナントと初期 admin を作る
  const created = await repos.tenants.createWithAdmin({
    name: 'テナント',
    admin: { email: 'admin@example.com', name: '管理者' },
    token: {
      prefix: 'aop_u_demo',
      tokenHash: hashSecret(adminToken),
      name: 'ダッシュボード',
      // 十分先の期限 (期限切れそのものを見るテストだけが別の値を使う)
      expiresAt: new Date(Date.now() + SECONDS_PER_DAY * 1000),
    },
  });
  // テナント id と平文トークンを返す
  return { repos, tenantId: created.tenant.id, adminToken };
}

describe('セッション Cookie の属性', () => {
  it('JavaScript から読めず、他サイトからの遷移では送らない', () => {
    // 非本番の属性を組み立てる
    const options = sessionCookieOptions(false);
    // XSS でトークンを抜かれないよう HttpOnly を立てる
    expect(options.httpOnly).toBe(true);
    // 他サイトからの遷移では送らない (CSRF 対策の 1 枚目)
    expect(options.sameSite).toBe('strict');
    // サイト全体で使う
    expect(options.path).toBe('/');
  });

  it('本番では Secure を付け、ローカルでは付けない', () => {
    // 本番は HTTPS 以外へ送らない
    expect(sessionCookieOptions(true).secure).toBe(true);
    // ローカルの http では付けない (付けると Cookie が保存されず開発できない)
    expect(sessionCookieOptions(false).secure).toBe(false);
  });

  it('Cookie の寿命はトークン自身の既定有効期限より短い', () => {
    // 寿命は正の値 (0 だとセッションが成立しない)
    expect(SESSION_COOKIE_MAX_AGE_SECONDS).toBeGreaterThan(0);
    // トークンの既定 (90 日) より短いことを求める。
    // 長くすると「トークンは生きているのに画面だけ開いたまま」の時間が延びる
    expect(SESSION_COOKIE_MAX_AGE_SECONDS).toBeLessThan(
      USER_TOKEN_DEFAULT_TTL_DAYS * SECONDS_PER_DAY,
    );
  });

  it('ログアウト用は maxAge だけ 0 で、他の属性は発行時と同じ', () => {
    // 発行時とログアウト時の属性を並べる
    const issued = sessionCookieOptions(true);
    const cleared = clearedSessionCookieOptions(true);
    // 即時に失効させる
    expect(cleared.maxAge).toBe(0);
    // **他の属性は 1 つも変えない** — path や sameSite が違うと別の Cookie として扱われ、
    // 古い Cookie が消えずに残る (ログアウトしたのにログインしたまま、という形になる)
    expect({ ...cleared, maxAge: issued.maxAge }).toEqual(issued);
  });
});

describe('resolveSessionPrincipal', () => {
  it('Cookie が無ければ null を返す', async () => {
    // 表だけ用意して Cookie 無しで呼ぶ
    const { repos } = await setupTenant();
    // undefined / 空文字列のどちらも未ログイン
    expect(await resolveSessionPrincipal(undefined, repos)).toBeNull();
    expect(await resolveSessionPrincipal('', repos)).toBeNull();
  });

  it('ユーザートークンの形でなければ DB を引かずに null を返す', async () => {
    // 引かれたら分かるように findByHash を落とす実装に差し替える
    const { repos } = await setupTenant();
    const guarded: Repositories = {
      ...repos,
      userTokens: {
        ...repos.userTokens,
        findByHash: () => {
          throw new Error('形が違うトークンで DB を引いてはいけない');
        },
      },
    };
    // API キー (プロキシ専用) は資格情報の系統が違うので受け付けない
    expect(await resolveSessionPrincipal(generateSecret('apiKey'), guarded)).toBeNull();
    // 無関係な文字列も同じ
    expect(await resolveSessionPrincipal('not-a-token', guarded)).toBeNull();
  });

  it('有効なユーザートークンならテナント付きの主体を返す', async () => {
    // 有効なトークンで呼ぶ
    const { repos, tenantId, adminToken } = await setupTenant();
    const principal = await resolveSessionPrincipal(adminToken, repos);
    // ユーザー主体として認証される
    expect(principal?.kind).toBe('user');
    // **テナント id が載っている** — 画面の全クエリがこの値で絞り込む (ADR-0002)
    expect(principal?.tenantId).toBe(tenantId);
    // 役割も載る (画面の出し分けと Server Action の認可が読む)
    expect(principal?.user.role).toBe('admin');
  });

  it('失効したトークンは null を返す', async () => {
    // 有効なトークンを作ってから失効させる
    const { repos, tenantId, adminToken } = await setupTenant();
    const found = await repos.userTokens.findByHash(hashSecret(adminToken));
    // 事前条件: 失効前は引ける
    expect(found).not.toBeNull();
    // 失効させる
    await repos.userTokens.revoke(tenantId, found!.user.id, found!.token.id);
    // 失効後は未ログイン
    expect(await resolveSessionPrincipal(adminToken, repos)).toBeNull();
  });

  it('期限切れのトークンは null を返す', async () => {
    // 期限が過去のトークンを別に発行する
    const { repos, tenantId, adminToken } = await setupTenant();
    const owner = await repos.userTokens.findByHash(hashSecret(adminToken));
    const expiredToken = generateSecret('user');
    await repos.userTokens.create({
      tenantId,
      userId: owner!.user.id,
      prefix: 'aop_u_old',
      tokenHash: hashSecret(expiredToken),
      name: '期限切れ',
      expiresAt: new Date(Date.now() - 1_000),
    });
    // 期限切れは未ログイン
    expect(await resolveSessionPrincipal(expiredToken, repos)).toBeNull();
  });

  it('無効化されたユーザーのトークンは null を返す', async () => {
    // 2 人目 (viewer) を作ってトークンを発行する。
    // 初期 admin を無効化すると「最後の admin」で拒否されるため、別のユーザーで確かめる
    const { repos, tenantId } = await setupTenant();
    const viewer = await repos.users.create({
      tenantId,
      email: 'viewer@example.com',
      name: '閲覧者',
      role: 'viewer',
    });
    const viewerToken = generateSecret('user');
    await repos.userTokens.create({
      tenantId,
      userId: viewer.id,
      prefix: 'aop_u_view',
      tokenHash: hashSecret(viewerToken),
      name: 'ダッシュボード',
      expiresAt: new Date(Date.now() + SECONDS_PER_DAY * 1000),
    });
    // 無効化する前は引ける
    expect(await resolveSessionPrincipal(viewerToken, repos)).not.toBeNull();
    // ユーザーを無効化する
    await repos.users.disable(tenantId, viewer.id);
    // 無効化後は未ログイン (トークン自体は失効していないが同じ扱いにする)
    expect(await resolveSessionPrincipal(viewerToken, repos)).toBeNull();
  });

  it('401 以外の例外は握り潰さず再送出する', async () => {
    // DB 障害を模して findByHash を落とす
    const { repos, adminToken } = await setupTenant();
    const broken: Repositories = {
      ...repos,
      userTokens: {
        ...repos.userTokens,
        findByHash: () => Promise.reject(new Error('DB 障害')),
      },
    };
    // **「ログアウト」に写さない** — 写すと障害の原因が画面から消える (§6)
    await expect(resolveSessionPrincipal(adminToken, broken)).rejects.toThrow('DB 障害');
  });
});
