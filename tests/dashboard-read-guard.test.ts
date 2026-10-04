// 画面側の**読み取り**に権限の判定が掛かっているかの検査（Step5）。
//
// **書き込み（停止 / 復帰 / 解決）の検査はあるのに、読み取りは認証だけで止まっていた。**
// 同じ数字を返す `GET /usage/daily` は `requireAction(principal, 'view')` を通すので、
// 画面が認証だけだと両者は「いまの許可表ではたまたま 3 役割すべてが `view` を持つ」という
// 偶然で一致しているに過ぎない。`view` を持たない役割が増えた瞬間、API は 403 なのに
// 画面はコスト・品質・稼働率を出し CSV まで落とせる fail-open が黙って生まれる。
//
// **いまの許可表には `view` を持たない役割が 1 つも無い**ので、役割を捏造する代わりに
// **許可表そのものを差し替えて「表を見ているか」**を確かめる（判定の配線を固定する）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LOGIN_PATH } from '@/lib/constants';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { seedEachTest } from './api/helpers';

// Cookie ストアの代わり（画面・ルートが読む値を入れる）
let cookieJar: Map<string, string>;
// 許可表が `view` を許すかどうか（テストごとに切り替える）
let allowView: boolean;
// redirect / notFound が呼ばれたことを見分ける印（どちらも例外を投げる）
const REDIRECT_MARK = 'REDIRECT';
const NOT_FOUND_MARK = 'NOT_FOUND';

// next/headers を差し替える（この経路が読むのは cookies だけ）
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        const found = cookieJar.get(name);
        return found === undefined ? undefined : { name, value: found };
      },
      set: () => {
        // 読み取りの経路は Cookie を書かない
      },
    }),
  headers: () => Promise.resolve({ get: () => null }),
}));

// next/navigation を差し替える（本物と同じく「投げて止まる」挙動にする）
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`${REDIRECT_MARK}:${path}`);
  },
  notFound: () => {
    throw new Error(NOT_FOUND_MARK);
  },
}));

// 許可表を差し替える（`view` の可否だけを切り替え、他の判定は本物のまま使う）
vi.mock('@/domain/rbac', async (importOriginal) => {
  // 本物の中身を取り込む
  const actual = await importOriginal<typeof import('@/domain/rbac')>();
  return {
    ...actual,
    canPerform: (role: Parameters<typeof actual.canPerform>[0], action: string) =>
      // view だけはテストの旗で答え、それ以外は本物の表に任せる
      action === 'view' ? allowView : actual.canPerform(role, action as 'execute'),
  };
});

// 差し替えたモジュールを使うので、import は mock の後に動的に読む
const { requireSession } = await import('@/lib/session-server');
const { GET: downloadDailyReport } = await import('@/app/(dashboard)/reports/daily/route');

// テナント A / B と 3 役割のユーザー・トークンを毎テスト作り直す
const seed = seedEachTest();

// ログイン済みの状態にする（Cookie にそのトークンを入れる）
function loginAs(sessionToken: string): void {
  cookieJar.set(SESSION_COOKIE_NAME, sessionToken);
}

// 投げられた印を取り出す（投げられなければ null）
async function thrownMark(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : null;
  }
}

// CSV ダウンロードを呼ぶ（期間の指定は既定に任せる）
function downloadRequest(): Request {
  return new Request('https://ops.example.com/reports/daily');
}

describe('画面の読み取りに掛かる権限の判定', () => {
  beforeEach(() => {
    // 既定は未ログイン・view は許す
    cookieJar = new Map();
    allowView = true;
  });

  it('未ログインならログイン画面へ送る', async () => {
    // Cookie が無い状態で画面の入口を呼ぶ
    expect(await thrownMark(() => requireSession())).toBe(`${REDIRECT_MARK}:${LOGIN_PATH}`);
  });

  it('ログイン済みで view を持つならセッションを返す', async () => {
    // viewer でも閲覧はできる（いまの許可表では 3 役割すべてが view を持つ）
    loginAs(seed.a.tokens.viewer);
    const session = await requireSession();
    // 自分のテナントの主体が返る
    expect(session.principal.tenantId).toBe(seed.a.id);
  });

  it('許可表が view を許さなければ画面は 404 にする（存在を隠す）', async () => {
    // 役割は本物のまま、許可表だけが「見てはいけない」と答える状態にする
    loginAs(seed.a.tokens.viewer);
    allowView = false;
    // **ここが要点** — 認証だけで止めていた版は、この状態でも画面を描いていた
    expect(await thrownMark(() => requireSession())).toBe(NOT_FOUND_MARK);
  });

  it('CSV のダウンロードは未ログインなら 401', async () => {
    // Cookie が無い状態で呼ぶ（画面と違いリダイレクト先が無いので 401 を返す）
    const response = await downloadDailyReport(downloadRequest());
    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });

  it('CSV のダウンロードも view を持たなければ 404', async () => {
    // ログインはしているが許可表が許さない状態
    loginAs(seed.a.tokens.viewer);
    allowView = false;
    const response = await downloadDailyReport(downloadRequest());
    // **レイアウトを通らない経路**なので、ここで見ていないと CSV だけ落とせてしまう
    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
  });

  it('view を持つなら CSV を返す（text/csv・キャッシュ禁止）', async () => {
    // 通常の状態
    loginAs(seed.a.tokens.viewer);
    const response = await downloadDailyReport(downloadRequest());
    // 中身が CSV として返る
    expect(response.headers.get('content-type')).toContain('text/csv');
    // テナントごとに違うので共有キャッシュに載せない
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
});
