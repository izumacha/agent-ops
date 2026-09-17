// Bearer 認証の経路: ヘッダ無し・形式違い・未知・失効・期限切れ・無効化ユーザー・プラットフォーム管理者
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET as getMe } from '@/app/api/v1/me/route';
import { GET as listTenants } from '@/app/api/v1/tenants/route';
import { generateSecret } from '@/lib/tokens';
import { call, PLATFORM_TOKEN, setupSeed, teardownSeed, type Seed } from './helpers';

// seed (各テストで作り直す)
let seed: Seed;
beforeEach(() => {
  seed = setupSeed();
});
// 後始末 (Composition Root と環境変数を戻す)
afterEach(teardownSeed);

describe('認証 (401 の経路)', () => {
  it('Authorization ヘッダが無ければ 401', async () => {
    // ヘッダ無し
    const result = await call(getMe);
    expect(result.status).toBe(401);
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

  it('存在しないユーザートークンは 401', async () => {
    // 形は正しいが DB に無いトークン
    expect((await call(getMe, { token: generateSecret('user') })).status).toBe(401);
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
