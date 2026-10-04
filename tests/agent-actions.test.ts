// エージェントの停止 / 復帰の Server Action（Step5）の検査。
//
// **API テストからは一切見えない層**なので、ここで固定しないと「画面の操作に権限チェックが無い」
// 「他サイトのフォームから他人のエージェントを止められる」「他テナントのエージェントを操作できる」
// といった退行が全件緑のまま通る（画面の層は Route Handler を通らないので route() の網も効かない）。
//
// `next/headers` / `next/navigation` / `next/cache` はテスト用に差し替える（Next のサーバを起こさない）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditAction } from '@/domain/audit/action';
import { AgentStatus, Role } from '@/domain/types';
import { LOGIN_PATH, UI_TEXT } from '@/lib/constants';
import { CSRF_FIELD_NAME, csrfTokenFor } from '@/lib/csrf';
import { DASHBOARD_ACTION_INITIAL, TARGET_ID_FIELD_NAME } from '@/lib/dashboard/form';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { AUDIT_SECRET, seedEachTest } from './api/helpers';

// 送信元として使うヘッダ（既定は自分自身からの要求）
let requestHeaders: Record<string, string>;
// Cookie ストアの代わり（Server Action が読む値を入れる）
let cookieJar: Map<string, string>;
// redirect が呼ばれた行き先を見分ける印（redirect は例外を投げる）
const REDIRECT_MARK = 'REDIRECT';

// next/headers を差し替える（cookies / headers の 2 つだけ使う）
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        const found = cookieJar.get(name);
        return found === undefined ? undefined : { name, value: found };
      },
      set: () => {
        // この Server Action は Cookie を書かない（書いたら気付けるよう何もしない）
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

// 表示の作り直しは副作用だけなので何もしない差し替え
vi.mock('next/cache', () => ({
  revalidatePath: () => {},
}));

// 差し替えたモジュールを使うので、import は mock の後に動的に読む
const { resumeAgent, stopAgent } = await import('@/app/(dashboard)/agents/actions');

// テナント A / B と 3 役割のユーザー・トークン・エージェントを毎テスト作り直す
const seed = seedEachTest();

// フォームの入力を組み立てる（token から CSRF トークンを導く）
function form(sessionToken: string, agentId: string): FormData {
  const data = new FormData();
  data.set(TARGET_ID_FIELD_NAME, agentId);
  data.set(CSRF_FIELD_NAME, csrfTokenFor(sessionToken));
  return data;
}

// ログイン済みの状態にする（Cookie にそのトークンを入れる）
function loginAs(sessionToken: string): void {
  cookieJar.set(SESSION_COOKIE_NAME, sessionToken);
}

// エージェントの現在の状態を読む
async function statusOf(tenantId: string, agentId: string): Promise<string | undefined> {
  const found = await seed.repos.agents.findById(tenantId, agentId);
  return found?.status;
}

// そのテナントの監査ログの操作名を並べる
async function auditActions(tenantId: string): Promise<string[]> {
  const page = await seed.repos.auditLogs.list(tenantId, { limit: 50 });
  return page.items.map((row) => row.action);
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

describe('エージェントの停止 / 復帰の Server Action', () => {
  beforeEach(() => {
    // 既定は自分自身からの要求・未ログイン
    requestHeaders = { origin: 'https://ops.example.com', host: 'ops.example.com' };
    cookieJar = new Map();
  });

  it('stop 権限があれば停止でき、監査ログに 1 行残る', async () => {
    // stop 権限を持つのは admin だけ（許可表 src/domain/rbac.ts が唯一の真実の源）
    loginAs(seed.a.tokens.admin);
    const state = await stopAgent(
      DASHBOARD_ACTION_INITIAL,
      form(seed.a.tokens.admin, seed.a.agent.id),
    );
    // 成功の文言が返る
    expect(state).toEqual({ error: null, message: UI_TEXT.agentStopped });
    // 状態が止まっている
    expect(await statusOf(seed.a.id, seed.a.agent.id)).toBe(AgentStatus.stopped);
    // **操作として記録されている**（API 経路と同じ操作名を使う）
    expect(await auditActions(seed.a.id)).toEqual([AuditAction.agent_stopped]);
  });

  it('止めたものを復帰できる（操作名は agent_resumed）', async () => {
    // いったん止めてから戻す
    loginAs(seed.a.tokens.admin);
    await stopAgent(DASHBOARD_ACTION_INITIAL, form(seed.a.tokens.admin, seed.a.agent.id));
    const state = await resumeAgent(
      DASHBOARD_ACTION_INITIAL,
      form(seed.a.tokens.admin, seed.a.agent.id),
    );
    // 成功の文言が返る
    expect(state).toEqual({ error: null, message: UI_TEXT.agentResumed });
    // 稼働中へ戻っている
    expect(await statusOf(seed.a.id, seed.a.agent.id)).toBe(AgentStatus.active);
    // 2 行とも残っている（止めた・戻したが区別できる）
    expect(await auditActions(seed.a.id)).toEqual([
      AuditAction.agent_stopped,
      AuditAction.agent_resumed,
    ]);
  });

  // **stop 権限を持たない役割を 1 つずつ見る。** viewer だけを見ていると「operator にも
  // 止めさせる」変更が素通りする（許可表では operator は view / execute だけ）
  it.each([Role.viewer, Role.operator])(
    '%s は停止できない（UI を隠すだけに頼らない）',
    async (role) => {
      // その役割でログインする
      loginAs(seed.a.tokens[role]);
      const state = await stopAgent(
        DASHBOARD_ACTION_INITIAL,
        form(seed.a.tokens[role], seed.a.agent.id),
      );
      // 権限が無い旨を返す
      expect(state.error).toBe(UI_TEXT.actionForbidden);
      // **状態は変わらず、監査ログも増えない**
      expect(await statusOf(seed.a.id, seed.a.agent.id)).toBe(AgentStatus.active);
      expect(await auditActions(seed.a.id)).toEqual([]);
    },
  );

  it('CSRF トークンが違えば断る', async () => {
    // 別のセッションから導いたトークンを載せる（攻撃者が自分の値を入れた形）
    loginAs(seed.a.tokens.admin);
    const data = form(seed.b.tokens.admin, seed.a.agent.id);
    const state = await stopAgent(DASHBOARD_ACTION_INITIAL, data);
    // 断られる
    expect(state.error).toBe(UI_TEXT.actionRejected);
    expect(await statusOf(seed.a.id, seed.a.agent.id)).toBe(AgentStatus.active);
  });

  it('CSRF トークンが無ければ断る（fail-closed）', async () => {
    // hidden 項目を落とした送信
    loginAs(seed.a.tokens.admin);
    const data = form(seed.a.tokens.admin, seed.a.agent.id);
    data.delete(CSRF_FIELD_NAME);
    const state = await stopAgent(DASHBOARD_ACTION_INITIAL, data);
    // 断られる
    expect(state.error).toBe(UI_TEXT.actionRejected);
    expect(await statusOf(seed.a.id, seed.a.agent.id)).toBe(AgentStatus.active);
  });

  it('他サイトからのフォーム送信は断る（CSRF の 1 枚目）', async () => {
    // Origin が別ホスト。**CSRF トークンは正しい値を載せる**ので、
    // この検査だけが止めていることが分かる
    loginAs(seed.a.tokens.admin);
    requestHeaders = { origin: 'https://evil.example.com', host: 'ops.example.com' };
    const state = await stopAgent(
      DASHBOARD_ACTION_INITIAL,
      form(seed.a.tokens.admin, seed.a.agent.id),
    );
    // 断られる
    expect(state.error).toBe(UI_TEXT.actionRejected);
    expect(await statusOf(seed.a.id, seed.a.agent.id)).toBe(AgentStatus.active);
  });

  it('未ログインならログイン画面へ送る', async () => {
    // Cookie が無い状態（セッション切れ後に古い画面から押した形）
    const target = await redirectTarget(() =>
      stopAgent(DASHBOARD_ACTION_INITIAL, form(seed.a.tokens.admin, seed.a.agent.id)),
    );
    // ログイン画面へ送られる
    expect(target).toBe(LOGIN_PATH);
    expect(await statusOf(seed.a.id, seed.a.agent.id)).toBe(AgentStatus.active);
  });

  it('他テナントのエージェントは「見つからない」として断る（存在を漏らさない）', async () => {
    // テナント A のユーザーがテナント B のエージェント id を送る
    loginAs(seed.a.tokens.admin);
    const state = await stopAgent(
      DASHBOARD_ACTION_INITIAL,
      form(seed.a.tokens.admin, seed.b.agent.id),
    );
    // 「見つかりません」だけを返す（403 と 404 を区別すると存在が漏れる。ADR-0002）
    expect(state.error).toBe(UI_TEXT.agentNotFound);
    // **相手テナントの状態は変わらない**
    expect(await statusOf(seed.b.id, seed.b.agent.id)).toBe(AgentStatus.active);
    // 監査ログも増えない（どちらのテナントにも）
    expect(await auditActions(seed.a.id)).toEqual([]);
    expect(await auditActions(seed.b.id)).toEqual([]);
  });

  it('資源 id の形でない値は断る', async () => {
    // パスに入らない形の値（NUL を含む等）を送る
    loginAs(seed.a.tokens.admin);
    const data = form(seed.a.tokens.admin, 'not an id\u0000');
    const state = await stopAgent(DASHBOARD_ACTION_INITIAL, data);
    // 断られる（形の定義は src/domain/resource-id.ts の 1 か所）
    expect(state.error).toBe(UI_TEXT.actionRejected);
  });

  it('監査ログの鍵が無ければ状態を変えずに失敗する（fail-closed）', async () => {
    // 鍵を消す（本番で未設定のときと同じ状態）
    loginAs(seed.a.tokens.admin);
    vi.stubEnv('AUDIT_HMAC_SECRET', '');
    // 失敗する（画面にはエラー境界が出る。**成功を返さない**ことが要点）
    await expect(
      stopAgent(DASHBOARD_ACTION_INITIAL, form(seed.a.tokens.admin, seed.a.agent.id)),
    ).rejects.toThrow();
    // 鍵を戻す
    vi.stubEnv('AUDIT_HMAC_SECRET', AUDIT_SECRET);
    // **状態は変わっていない**（記録の無い変更を残さない）
    expect(await statusOf(seed.a.id, seed.a.agent.id)).toBe(AgentStatus.active);
  });
});
