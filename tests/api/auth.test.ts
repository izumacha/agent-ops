// Bearer 認証の経路: ヘッダ無し・形式違い・未知・失効・期限切れ・無効化ユーザー・プラットフォーム管理者
import { describe, expect, it } from 'vitest';
import { GET as getMe } from '@/app/api/v1/me/route';
import { GET as listTenants } from '@/app/api/v1/tenants/route';
import { generateSecret } from '@/lib/tokens';
import { call, PLATFORM_TOKEN, seedEachTest } from './helpers';

// seed (各テストで作り直し、後始末も helpers が行う)
const seed = seedEachTest();

describe('認証 (401 の経路)', () => {
  it('Authorization ヘッダが無ければ 401 で、WWW-Authenticate に Bearer 方式を示す', async () => {
    // ヘッダ無し
    const result = await call(getMe);
    expect(result.status).toBe(401);
    expect(result.headers.get('www-authenticate')).toBe('Bearer realm="agent-ops"');
  });

  it('Bearer 以外の方式・トークン無し・余分な語は 401', async () => {
    // Basic 方式
    expect((await call(getMe, { headers: { authorization: 'Basic abc' } })).status).toBe(401);
    // トークン無し
    expect((await call(getMe, { headers: { authorization: 'Bearer' } })).status).toBe(401);
    // 余分な語
    expect((await call(getMe, { headers: { authorization: 'Bearer a b' } })).status).toBe(401);
  });

  it('方式名は大文字小文字を区別しない (bearer でも通る)', async () => {
    // 小文字の方式名
    const result = await call(getMe, {
      headers: { authorization: `bearer ${seed.a.tokens.viewer}` },
    });
    expect(result.status).toBe(200);
  });

  it('存在しないユーザートークンは 401 で、WWW-Authenticate は invalid_token', async () => {
    // 形は正しいが DB に無いトークン
    const result = await call(getMe, { token: generateSecret('user') });
    expect(result.status).toBe(401);
    expect(result.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('失効したトークンは 401', async () => {
    // viewer のトークン行を失効させる
    seed.store.userTokens.get(seed.a.tokenRows.viewer.id)!.revokedAt = new Date();
    expect((await call(getMe, { token: seed.a.tokens.viewer })).status).toBe(401);
  });

  it('期限切れのトークンは 401', async () => {
    // 期限を過去にする
    seed.store.userTokens.get(seed.a.tokenRows.viewer.id)!.expiresAt = new Date(Date.now() - 1000);
    expect((await call(getMe, { token: seed.a.tokens.viewer })).status).toBe(401);
  });

  it('応答は保存させない (Cache-Control: no-store と Vary: Authorization)', async () => {
    // 成功応答 (テナント固有の内容)
    const ok = await call(getMe, { token: seed.a.tokens.viewer });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.headers.get('vary') ?? '').toContain('Authorization');
    // 失敗応答 (401 も資格情報ごとに違う)
    const unauthorized = await call(getMe);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('cache-control')).toBe('no-store');
    expect(unauthorized.headers.get('vary') ?? '').toContain('Authorization');
    // 401 の WWW-Authenticate は残る (ヘッダを作り直しても消えない)
    expect(unauthorized.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('無効化されたユーザーのトークンは 401', async () => {
    // ユーザーを無効化する
    seed.store.users.get(seed.a.users.viewer.id)!.disabledAt = new Date();
    expect((await call(getMe, { token: seed.a.tokens.viewer })).status).toBe(401);
  });

  it('API キーの形 (aop_k_) のトークンは API では 401 (プロキシ専用)', async () => {
    // API キーはプロキシ (Step2) の認証情報であり、管理 API には使えない
    expect((await call(getMe, { token: generateSecret('apiKey') })).status).toBe(401);
  });
});

describe('プラットフォーム管理者トークン', () => {
  it('環境変数と一致すればテナント一覧を呼べる', async () => {
    // 一致するトークン
    const result = await call(listTenants, { token: PLATFORM_TOKEN });
    expect(result.status).toBe(200);
  });

  it('aop_u_ で始まる値を設定してもプラットフォーム管理者として認証できる (ユーザートークンの経路に吸われない)', async () => {
    // 運用者がユーザートークンと同じ接頭辞の値を設定したケース
    process.env.PLATFORM_ADMIN_TOKEN = 'aop_u_platform-0123456789abcdefghijklmnopqrstuvwxyz';
    expect((await call(listTenants, { token: process.env.PLATFORM_ADMIN_TOKEN })).status).toBe(200);
  });

  it('一致しなければ 401', async () => {
    // 末尾だけ違うトークン
    expect((await call(listTenants, { token: `${PLATFORM_TOKEN}x` })).status).toBe(401);
  });

  it('環境変数が未設定なら誰もプラットフォーム管理者になれない', async () => {
    // 未設定にする
    delete process.env.PLATFORM_ADMIN_TOKEN;
    expect((await call(listTenants, { token: PLATFORM_TOKEN })).status).toBe(401);
  });

  it('環境変数が短すぎる値なら無視して 401 (弱いトークンを使わせない)', async () => {
    // 32 文字未満
    process.env.PLATFORM_ADMIN_TOKEN = 'short';
    expect((await call(listTenants, { token: 'short' })).status).toBe(401);
  });
});

describe('GET /me', () => {
  it('認証中のユーザーと所属テナントを返す (ハッシュは含まない)', async () => {
    // operator で呼ぶ
    const result = await call(getMe, { token: seed.a.tokens.operator });
    expect(result.status).toBe(200);
    // 自分とテナント
    const body = result.json as { user: { id: string; role: string }; tenant: { id: string } };
    expect(body.user.id).toBe(seed.a.users.operator.id);
    expect(body.user.role).toBe('operator');
    expect(body.tenant.id).toBe(seed.a.id);
    // 秘密が漏れていないこと
    expect(JSON.stringify(result.json)).not.toContain('tokenHash');
  });

  it('プラットフォーム管理者には「自分」が無いので 403', async () => {
    // テナントの外側
    expect((await call(getMe, { token: PLATFORM_TOKEN })).status).toBe(403);
  });
});
