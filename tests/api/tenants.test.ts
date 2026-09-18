// テナント API: 作成 (admin + トークン同時発行)・一覧・取得
import { describe, expect, it } from 'vitest';
import { GET as getMe } from '@/app/api/v1/me/route';
import { GET as listTenants, POST as createTenant } from '@/app/api/v1/tenants/route';
import { GET as getTenant } from '@/app/api/v1/tenants/[tenantId]/route';
import { USER_TOKEN_DEFAULT_TTL_DAYS, USER_TOKEN_MAX_TTL_DAYS } from '@/lib/constants';
import { USER_TOKEN_PREFIX } from '@/lib/tokens';
import { call, PLATFORM_TOKEN, seedEachTest } from './helpers';

// 1 日のミリ秒 (有効期限の日数を求めるため)
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

// seed (各テストで作り直し、後始末も helpers が行う)
const seed = seedEachTest();

// 作成応答の形
interface Created {
  tenant: { id: string; name: string; plan: string };
  admin: { id: string; role: string; email: string; name: string };
  adminToken: { secret: string; prefix: string; name: string; expiresAt: string };
}

describe('POST /tenants', () => {
  it('テナントと最初の admin と、その admin として使えるトークンを返す (UC-01)', async () => {
    // プラットフォーム管理者で作成する
    const result = await call(createTenant, {
      token: PLATFORM_TOKEN,
      body: { name: '新テナント', adminEmail: 'owner@example.com', adminName: 'オーナー' },
    });
    expect(result.status).toBe(201);
    // 3 つが揃っていること
    const body = result.json as Created;
    expect(body.tenant.name).toBe('新テナント');
    expect(body.tenant.plan).toBe('free');
    expect(body.admin.role).toBe('admin');
    // 送った本文の各項目が、そのまま作られていること (固定値へ差し替える変更をここで落とす)
    expect(body.admin.email).toBe('owner@example.com');
    expect(body.admin.name).toBe('オーナー');
    // ブートストラップトークンの有効期限。新テナントで唯一発行される全権資格情報なので、
    // 既定の日数で切れること・上限を超えないことを見る (ADR-0005「無期限は作れない」)。
    // 発行 API 側 (POST /users/{id}/tokens) には同じ表明があるのに、より強いこちらだけ無検証だった
    const expiresAt = new Date(body.adminToken.expiresAt).getTime();
    const days = (expiresAt - Date.now()) / MILLIS_PER_DAY;
    expect(days).toBeGreaterThan(USER_TOKEN_DEFAULT_TTL_DAYS - 1);
    expect(days).toBeLessThan(USER_TOKEN_DEFAULT_TTL_DAYS + 1);
    expect(days).toBeLessThanOrEqual(USER_TOKEN_MAX_TTL_DAYS);
    expect(body.adminToken.secret.startsWith(USER_TOKEN_PREFIX)).toBe(true);
    expect(body.adminToken.secret.startsWith(body.adminToken.prefix)).toBe(true);
    // 返ったトークンでその admin として認証できること
    const me = await call(getMe, { token: body.adminToken.secret });
    expect(me.status).toBe(200);
    expect((me.json as { user: { id: string } }).user.id).toBe(body.admin.id);
  });

  it('入力検証: 名前・メール・表示名が不正なら 422 で issues を返す', async () => {
    // 空の名前・不正メール・表示名欠落
    const result = await call(createTenant, {
      token: PLATFORM_TOKEN,
      body: { name: '', adminEmail: 'not-an-email' },
    });
    expect(result.status).toBe(422);
    // どのフィールドかが issues に載る
    const issues = (result.json as { issues: { path: string }[] }).issues.map((i) => i.path);
    expect(issues).toEqual(expect.arrayContaining(['name', 'adminEmail', 'adminName']));
  });

  it('テナントの admin では作れない (403)', async () => {
    // テナント内の admin
    const result = await call(createTenant, {
      token: seed.a.tokens.admin,
      body: { name: 'x', adminEmail: 'x@example.com', adminName: 'x' },
    });
    expect(result.status).toBe(403);
  });
});

describe('GET /tenants', () => {
  it('limit と cursor でページ送りできる', async () => {
    // seed の 2 テナントを 1 件ずつ取る
    const first = await call(listTenants, { token: PLATFORM_TOKEN, query: 'limit=1' });
    expect(first.status).toBe(200);
    const page1 = first.json as { items: { id: string }[]; nextCursor?: string };
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBeDefined();
    // 続き
    const second = await call(listTenants, {
      token: PLATFORM_TOKEN,
      query: `limit=1&cursor=${page1.nextCursor}`,
    });
    const page2 = second.json as { items: { id: string }[]; nextCursor?: string };
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0].id).not.toBe(page1.items[0].id);
    expect(page2.nextCursor).toBeUndefined();
  });

  it('limit が上限を超える・0・数字でない・10 進整数以外 (16 進・指数・符号・空白) は 422', async () => {
    // 上限超え / 0 / 文字 / 16 進 / 指数 / 符号 / 空白 / 小数
    for (const query of [
      'limit=201',
      'limit=0',
      'limit=abc',
      'limit=0x10',
      'limit=1e2',
      'limit=%2B5',
      'limit=%207%20',
      'limit=1.5',
    ]) {
      expect((await call(listTenants, { token: PLATFORM_TOKEN, query })).status, query).toBe(422);
    }
    // 10 進整数は通る
    expect((await call(listTenants, { token: PLATFORM_TOKEN, query: 'limit=2' })).status).toBe(200);
  });
});

describe('GET /tenants/{tenantId}', () => {
  it('自テナントは取得できる (viewer でも view 権限があれば可)', async () => {
    // 自分のテナント
    const result = await call(getTenant, {
      token: seed.a.tokens.viewer,
      params: { tenantId: seed.a.id },
    });
    expect(result.status).toBe(200);
    expect((result.json as { id: string }).id).toBe(seed.a.id);
  });

  it('他テナントの id は 404 で隠す (admin でも)', async () => {
    // テナント B の id をテナント A の admin が指定する
    const result = await call(getTenant, {
      token: seed.a.tokens.admin,
      params: { tenantId: seed.b.id },
    });
    expect(result.status).toBe(404);
  });
});
