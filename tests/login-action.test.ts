// ログイン / ログアウトの Server Action (Step5) の検査。
//
// **API テストからは一切見えない層**なので、ここで固定しないと「他サイトのフォームから
// 他人のセッションを張れる」「失敗の理由が漏れる」といった退行が全件緑のまま通る。
// `next/headers` と `next/navigation` はテスト用に差し替える（DOM も Next のサーバも起こさない）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureLogOutlet, parseLoggedLine } from './lib/log-lines';
import { createMemoryRepos, MemoryStore } from '@/data/adapters/memory';
import { setReposForTesting } from '@/data';
import type { Repositories } from '@/data/ports';
import { DASHBOARD_PATH, LOGIN_PATH, UI_TEXT } from '@/lib/constants';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { generateSecret, hashSecret } from '@/lib/tokens';
import { resetThrottledLogsForTesting } from '@/lib/log';

// 送信元として使うヘッダ（既定は自分自身からの要求）
let requestHeaders: Record<string, string>;
// Cookie ストアの代わり（Server Action が書いた値を見るために残す）
let cookieJar: Map<string, { value: string; options: unknown }>;
// redirect が呼ばれた行き先（redirect は例外を投げるので捕まえて確かめる）
const REDIRECT_MARK = 'REDIRECT';

// next/headers を差し替える（cookies / headers の 2 つだけ使う）
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        const found = cookieJar.get(name);
        return found === undefined ? undefined : { name, value: found.value };
      },
      set: (name: string, value: string, options: unknown) => {
        cookieJar.set(name, { value, options });
      },
    }),
  headers: () =>
    Promise.resolve({
      get: (name: string) => requestHeaders[name.toLowerCase()] ?? null,
    }),
}));

// next/navigation の redirect を差し替える（本物と同じく「投げて止まる」挙動にする）
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`${REDIRECT_MARK}:${path}`);
  },
}));

// 差し替えたモジュールを使うので、import は mock の後に動的に読む
const { login, logout } = await import('@/app/login/actions');

// テナントと有効なトークンを 1 組作る
async function setup(): Promise<{ repos: Repositories; token: string }> {
  const repos = createMemoryRepos(new MemoryStore());
  const token = generateSecret('user');
  await repos.tenants.createWithAdmin({
    name: 'テナント',
    admin: { email: 'admin@example.com', name: '管理者' },
    token: {
      prefix: 'aop_u_demo',
      tokenHash: hashSecret(token),
      name: 'ダッシュボード',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return { repos, token };
}

// フォームの入力を組み立てる
function form(token: string): FormData {
  const data = new FormData();
  data.set('token', token);
  return data;
}

// redirect の行き先を取り出す（投げられなければ null）
async function redirectTarget(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return message.startsWith(`${REDIRECT_MARK}:`) ? message.slice(REDIRECT_MARK.length + 1) : null;
  }
}

describe('ログインの Server Action', () => {
  // ログの出口（`console.error`）を捕まえる。**Server Action の応答は
  // `agentops_http_responses_total` に乗らない**（`src/lib/uncounted-response-sources.ts` の
  // `UNCOUNTED_RESPONSE_SOURCES`）ので、拒否が外から見える唯一の出口がこの行
  let outlet: ReturnType<typeof captureLogOutlet>;

  beforeEach(() => {
    // 既定は自分自身からの要求
    requestHeaders = { origin: 'https://ops.example.com', host: 'ops.example.com' };
    cookieJar = new Map();
    // 出口を差し替える（本文は出さない）。**`warn` と `error` の両方**を捕まえる —
    // 深刻度の正本は `LOG_EVENTS` で、出口のメソッドはそこから決まるので、テスト側で
    // どちらかを決め打つと語彙の `level` を変えた瞬間に何も見なくなる
    outlet = captureLogOutlet();
    // 間引きの記憶も忘れる（**未認証経路の「断った」記録は窓あたり 1 本**なので、
    // 前のテストが 1 本出していると次のテストでは出ない）
    resetThrottledLogsForTesting();
  });

  afterEach(() => {
    // 差し替えたデータ層を戻す
    setReposForTesting(undefined);
    // 出口を戻す
    outlet.restore();
  });

  it('有効なトークンならセッション Cookie を張ってダッシュボードへ送る', async () => {
    // 有効なトークンで送信する
    const { repos, token } = await setup();
    setReposForTesting(repos);
    const target = await redirectTarget(() => login({ error: null }, form(token)));
    // ダッシュボードへ送られる
    expect(target).toBe(DASHBOARD_PATH);
    // Cookie が張られている
    expect(cookieJar.get(SESSION_COOKIE_NAME)?.value).toBe(token);
    // **HttpOnly / SameSite=Strict が付いている**（画面側で属性を書き分けていない）
    expect(cookieJar.get(SESSION_COOKIE_NAME)?.options).toMatchObject({
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
    });
  });

  it('前後の空白は落として照合する（貼り付け事故を救う）', async () => {
    // 改行と空白を付けて貼り付けた状態
    const { repos, token } = await setup();
    setReposForTesting(repos);
    const target = await redirectTarget(() => login({ error: null }, form(`  ${token}\n`)));
    // 通ってダッシュボードへ送られる
    expect(target).toBe(DASHBOARD_PATH);
    // Cookie には**空白を落とした値**が入る（そのまま入れると次回の照合で落ちる）
    expect(cookieJar.get(SESSION_COOKIE_NAME)?.value).toBe(token);
  });

  it('他サイトからのフォーム送信は Cookie を張らずに断る（セッション固定攻撃）', async () => {
    // Origin が別ホスト
    const { repos, token } = await setup();
    setReposForTesting(repos);
    requestHeaders = { origin: 'https://evil.example.com', host: 'ops.example.com' };
    const state = await login({ error: null }, form(token));
    // 失敗の文言が返り、リダイレクトもしない
    expect(state.error).toBe(UI_TEXT.loginFailed);
    // **Cookie は 1 つも張られていない**（張られると攻撃者のトークンで被害者がログインする）
    expect(cookieJar.size).toBe(0);
    // **断ったことがログに出ていること**（この経路は応答が数えられないので、ログが唯一の出口）
    expect(parseLoggedLine(outlet.calls()[0]).event).toBe('session.cross_origin_action');
  });

  it('Origin が無い要求も断る（fail-closed）', async () => {
    // ヘッダを落とした要求
    const { repos, token } = await setup();
    setReposForTesting(repos);
    requestHeaders = { host: 'ops.example.com' };
    const state = await login({ error: null }, form(token));
    expect(state.error).toBe(UI_TEXT.loginFailed);
    expect(cookieJar.size).toBe(0);
  });

  it('入力が空なら入力を促す文言を返す', async () => {
    // 空白だけを送る
    const { repos } = await setup();
    setReposForTesting(repos);
    const state = await login({ error: null }, form('   '));
    // 「入力してください」側の文言（トークンが違う話ではない）
    expect(state.error).toBe(UI_TEXT.loginTokenRequired);
    expect(cookieJar.size).toBe(0);
  });

  it('失敗の理由を区別しない（存在しない・形が違うで同じ文言）', async () => {
    // 形は正しいが DB に無いトークンと、形が違う文字列
    const { repos } = await setup();
    setReposForTesting(repos);
    const unknownToken = await login({ error: null }, form(generateSecret('user')));
    const malformed = await login({ error: null }, form('not-a-token'));
    // **同じ文言**（区別するとトークンの状態を外から探れる。ADR-0005 の 401 と同じ方針）
    expect(unknownToken.error).toBe(UI_TEXT.loginFailed);
    expect(malformed.error).toBe(UI_TEXT.loginFailed);
    expect(cookieJar.size).toBe(0);
  });

  it('拒否はサーバログに 1 行残る（トークンも理由も出さない）', async () => {
    // 形は正しいが DB に無いトークンを送る
    const { repos } = await setup();
    setReposForTesting(repos);
    const rejected = generateSecret('user');
    await login({ error: null }, form(rejected));
    // **1 行出ていること** — Server Action の応答は数えられないので、総当たりが見える唯一の出口
    expect(outlet.calls().length, 'ログが 1 行も出ていない').toBe(1);
    const line = parseLoggedLine(outlet.calls()[0]);
    // 出来事の識別子（警報の条件に使うのはこれ）
    expect(line.event).toBe('session.login_rejected');
    // **貼られたトークンそのものは出さない**（出すと秘密がログへ流れる）
    expect(JSON.stringify(line)).not.toContain(rejected);
  });

  it('入力が空のときは拒否の行を出さない（利用者の打ち間違いで総当たりの警報を鳴らさない）', async () => {
    // 空白だけを送る
    const { repos } = await setup();
    setReposForTesting(repos);
    await login({ error: null }, form('   '));
    // 1 行も出ていないこと（照合まで届いていないので「拒否」ではない）
    expect(outlet.calls().length).toBe(0);
  });

  it('API キーではログインできない（資格情報の系統を混ぜない）', async () => {
    // プロキシ専用の API キーを貼る
    const { repos } = await setup();
    setReposForTesting(repos);
    const state = await login({ error: null }, form(generateSecret('apiKey')));
    // 通らない
    expect(state.error).toBe(UI_TEXT.loginFailed);
    expect(cookieJar.size).toBe(0);
    // **このテストは「形の検査」を守っていない。** API キーのハッシュは UserToken 表に無いので、
    // `isUserToken` の門番を外しても結果は変わらない（実測で全件緑のまま通った）。
    // 守っているのは tests/session.test.ts の「形が違うトークンで DB を引かない」側で、
    // ここで見ているのは利用者に見える振る舞い（同じ文言・Cookie を張らない）だけ
  });
});

describe('ログアウトの Server Action', () => {
  beforeEach(() => {
    requestHeaders = { origin: 'https://ops.example.com', host: 'ops.example.com' };
    cookieJar = new Map();
  });

  it('Cookie を失効させてログイン画面へ送る', async () => {
    // ログイン済みの状態を作る
    cookieJar.set(SESSION_COOKIE_NAME, { value: 'aop_u_whatever', options: {} });
    const target = await redirectTarget(() => logout());
    // ログイン画面へ送られる
    expect(target).toBe(LOGIN_PATH);
    // **maxAge 0 で上書きされている**（属性は発行時とそろえる）
    expect(cookieJar.get(SESSION_COOKIE_NAME)?.value).toBe('');
    expect(cookieJar.get(SESSION_COOKIE_NAME)?.options).toMatchObject({ maxAge: 0, path: '/' });
  });

  it('他サイトからは勝手にログアウトさせられない', async () => {
    // ログイン済みの状態で、別オリジンから呼ぶ
    cookieJar.set(SESSION_COOKIE_NAME, { value: 'aop_u_whatever', options: {} });
    requestHeaders = { origin: 'https://evil.example.com', host: 'ops.example.com' };
    await logout();
    // Cookie はそのまま（消されない）
    expect(cookieJar.get(SESSION_COOKIE_NAME)?.value).toBe('aop_u_whatever');
  });
});
