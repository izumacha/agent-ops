// Bearer 認証の経路: ヘッダ無し・形式違い・未知・失効・期限切れ・無効化ユーザー・プラットフォーム管理者
import { describe, expect, it, vi } from 'vitest';
import { GET as getMe } from '@/app/api/v1/me/route';
import { GET as listTenants } from '@/app/api/v1/tenants/route';
import { GET as getTenant } from '@/app/api/v1/tenants/[tenantId]/route';
import { PLATFORM_ADMIN_TOKEN_MIN_LENGTH } from '@/lib/constants';
import { generateSecret } from '@/lib/tokens';
import { call, PLATFORM_TOKEN, seedApiKey, seedEachTest } from './helpers';

// seed (各テストで作り直し、後始末も helpers が行う)
const seed = seedEachTest();

describe('認証 (401 の経路)', () => {
  it('Authorization ヘッダが無ければ 401 で、WWW-Authenticate に Bearer 方式を示す', async () => {
    // ヘッダ無し
    const result = await call(getMe);
    expect(result.status).toBe(401);
    expect(result.headers.get('www-authenticate')).toBe('Bearer realm="agent-ops"');
  });

  it('有効な API キーをユーザー向け API へ出しても 401 (資格情報の系統を混ぜない)', async () => {
    // エージェントに紐づいた有効な API キーを 1 本発行する
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    // ユーザー向け API へ出す
    const result = await call(getMe, { token: key.secret });
    // **401 であること (403 ではない)** — `authenticate()` が API キーも受け付けるように
    // なると、エージェント用の資格情報 (CI やエージェント実行環境に配るので流出しやすい) が
    // ユーザー向け API の認証を通る。実測で、`authenticate()` に 1 行足して受理させると
    // 864 件すべて緑・件数も不変のまま、`/me` が 403「テナントのユーザーとして認証した
    // ときだけ…」を返すようになり、**キーが有効か・紐づくエージェントが停止中かを
    // 答えるオラクル**がユーザー向け API 上に生えた (403 を許すとこのオラクルが残る)。
    // 逆向き (API キー経路がユーザートークンを受け付ける) は既に 6 件が赤くなる
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

  it('期限切れのトークンは 401 (期限ちょうども切れているものとして扱う)', async () => {
    // 期限を過去にする
    seed.store.userTokens.get(seed.a.tokenRows.viewer.id)!.expiresAt = new Date(Date.now() - 1000);
    expect((await call(getMe, { token: seed.a.tokens.viewer })).status).toBe(401);
    // 期限が「まさに今」のトークンも通さない (判定を < にすると 1 ミリ秒だけ通ってしまう)。
    // 時計を固定してから、その時刻ちょうどを期限にする
    const now = new Date('2026-09-18T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      seed.store.userTokens.get(seed.a.tokenRows.operator.id)!.expiresAt = now;
      expect((await call(getMe, { token: seed.a.tokens.operator })).status).toBe(401);
    } finally {
      // 時計を戻す
      vi.useRealTimers();
    }
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

  it('/me と GET /tenants/{id} は認証したユーザーのテナントを返す (テナント B でも自分の側)', async () => {
    // テナント B のユーザーで /me
    const me = await call(getMe, { token: seed.b.tokens.admin });
    expect(me.status).toBe(200);
    expect((me.json as { tenant: { id: string } }).tenant.id).toBe(seed.b.id);
    // テナント A の id を B のトークンで引くと 404 (存在を漏らさない)
    const foreign = await call(getTenant, {
      token: seed.b.tokens.admin,
      params: { tenantId: seed.a.id },
    });
    expect(foreign.status).toBe(404);
    // 自テナントなら取れる
    const own = await call(getTenant, {
      token: seed.b.tokens.admin,
      params: { tenantId: seed.b.id },
    });
    expect(own.status).toBe(200);
    expect((own.json as { id: string }).id).toBe(seed.b.id);
  });

  it('有効なトークンでも Bearer 以外の方式・余分な語なら 401 (RFC 6750 の形だけ受ける)', async () => {
    // 同じトークンを Basic で運ぶ
    const basic = await call(getMe, {
      headers: { authorization: `Basic ${seed.a.tokens.viewer}` },
    });
    expect(basic.status).toBe(401);
    // Bearer の後ろに余分な語を足す
    const extra = await call(getMe, {
      headers: { authorization: `Bearer ${seed.a.tokens.viewer} extra` },
    });
    expect(extra.status).toBe(401);
    // 正しい形なら通る (上の 2 つがトークンの無効さで落ちていないことの裏取り)
    const ok = await call(getMe, {
      headers: { authorization: `Bearer ${seed.a.tokens.viewer}` },
    });
    expect(ok.status).toBe(200);
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

  it('API キーの形のトークンでは DB を引かない (未認証で叩ける入口を絞る)', async () => {
    // ハッシュ照合 (未認証で到達できる唯一の DB アクセス) を見張る
    const findByHash = vi.spyOn(seed.repos.userTokens, 'findByHash');
    // API キーの形は API では使えない。形で弾くので DB までは行かない
    expect((await call(getMe, { token: generateSecret('apiKey') })).status).toBe(401);
    expect(findByHash).not.toHaveBeenCalled();
    // ユーザートークンの形なら照合まで行く (「いつでも呼ばれない」実装でも緑にならないように対で見る)。
    // 結果はどちらも 401 なので、状態だけを見ていると形の判定を外しても気付けない — 呼ばれたかどうかを見る
    expect((await call(getMe, { token: generateSecret('user') })).status).toBe(401);
    expect(findByHash).toHaveBeenCalledTimes(1);
    findByHash.mockRestore();
  });

  it('環境変数が未設定なら誰もプラットフォーム管理者になれない', async () => {
    // 未設定にする
    delete process.env.PLATFORM_ADMIN_TOKEN;
    expect((await call(listTenants, { token: PLATFORM_TOKEN })).status).toBe(401);
  });

  it('環境変数が短すぎる値なら無視して 401 (弱いトークンを使わせない)', async () => {
    // 境界のちょうど 1 文字下 (リテラルではなく定数から作る。'short' のような固定値だと、上限を 6 まで
    // 下げる変更でも緑のまま通ってしまう)
    const tooShort = 'a'.repeat(PLATFORM_ADMIN_TOKEN_MIN_LENGTH - 1);
    process.env.PLATFORM_ADMIN_TOKEN = tooShort;
    expect((await call(listTenants, { token: tooShort })).status).toBe(401);
    // 境界ちょうどは受け付ける (上限を厳しくしすぎる変更もここで落ちる)
    const atLimit = 'a'.repeat(PLATFORM_ADMIN_TOKEN_MIN_LENGTH);
    process.env.PLATFORM_ADMIN_TOKEN = atLimit;
    expect((await call(listTenants, { token: atLimit })).status).toBe(200);
  });

  it('最小長そのものが 32 文字以上である (弱いトークンを許す方向へ動かさない)', () => {
    // この 32 はテストが手で持つ唯一の値で、定数を下げると落ちる。
    // 失効も期限切れも無く全テナントの作成・列挙を握る資格情報なので、下げるときは人の判断を必ず一度通す
    // (認証経路のレート制限は Step6 の宿題＝いまは総当たりを阻む層がここしか無い)
    expect(PLATFORM_ADMIN_TOKEN_MIN_LENGTH).toBeGreaterThanOrEqual(32);
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
