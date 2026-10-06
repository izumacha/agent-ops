// インシデントを解決する Server Action（Step5）の検査。
//
// **API テストからは一切見えない層**なので、ここで固定しないと「画面の操作に admin 限定が無い」
// 「他サイトのフォームから他人のインシデントを閉じられる」「他テナントのものを閉じられる」
// といった退行が全件緑のまま通る。
//
// `next/headers` / `next/navigation` / `next/cache` はテスト用に差し替える（Next のサーバを起こさない）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditAction } from '@/domain/audit/action';
import { IncidentStatus, Role, RuleAction, RuleKind } from '@/domain/types';
import { INCIDENTS_PATH, LOGIN_PATH, UI_TEXT } from '@/lib/constants';
import { CSRF_FIELD_NAME, csrfTokenFor } from '@/lib/csrf';
// ガードレールのルールを作るときの上限（上限そのものを主題にしないので共有の値）
import { TEST_GUARDRAIL_RULE_LIMITS } from './lib/guardrail-limits';
import {
  DASHBOARD_ACTION_INITIAL,
  RESULT_INCIDENT_RESOLVED,
  RESULT_QUERY_NAME,
  TARGET_ID_FIELD_NAME,
} from '@/lib/dashboard/form';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { AUDIT_SECRET, seedEachTest, type SeededTenant } from './api/helpers';

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
        // この Server Action は Cookie を書かない
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
const { resolveIncident } = await import('@/app/(dashboard)/incidents/actions');

// テナント A / B と 3 役割のユーザー・トークン・エージェントを毎テスト作り直す
const seed = seedEachTest();

// そのテナントに「発火したインシデント」を 1 件作る（ルールを作ってから発火させる）
async function raiseIncident(tenant: SeededTenant): Promise<string> {
  // 判定の対象になるルールを 1 本作る（上限は定数から渡す。省略できない）
  const created = await seed.repos.guardrailRules.create(
    {
      tenantId: tenant.id,
      agentId: tenant.agent.id,
      kind: RuleKind.cost,
      threshold: 1,
      windowMinutes: 60,
      action: RuleAction.notify,
    },
    TEST_GUARDRAIL_RULE_LIMITS,
  );
  // 作れていることを前提にする（作れないならテストの仕込みが壊れている）
  if (created.status !== 'created') throw new Error('ルールを作れませんでした');
  // 発火させる（停止はしない notify のルール）
  const raised = await seed.repos.incidents.raise({
    tenantId: tenant.id,
    agentId: tenant.agent.id,
    ruleId: created.rule.id,
    summary: 'テスト用の発火',
    suspendAgent: false,
  });
  // 発火できていることを前提にする
  if (raised === null) throw new Error('インシデントを作れませんでした');
  // 作ったインシデントの id
  return raised.incident.id;
}

// フォームの入力を組み立てる（token から CSRF トークンを導く）
function form(sessionToken: string, incidentId: string): FormData {
  const data = new FormData();
  data.set(TARGET_ID_FIELD_NAME, incidentId);
  data.set(CSRF_FIELD_NAME, csrfTokenFor(sessionToken));
  return data;
}

// ログイン済みの状態にする（Cookie にそのトークンを入れる）
function loginAs(sessionToken: string): void {
  cookieJar.set(SESSION_COOKIE_NAME, sessionToken);
}

// インシデントの現在の状態を読む
async function statusOf(tenantId: string, incidentId: string): Promise<string | undefined> {
  const found = await seed.repos.incidents.findById(tenantId, incidentId);
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

describe('インシデントを解決する Server Action', () => {
  beforeEach(() => {
    // 既定は自分自身からの要求・未ログイン
    requestHeaders = { origin: 'https://ops.example.com', host: 'ops.example.com' };
    cookieJar = new Map();
  });

  it('admin なら解決でき、監査ログに 1 行残る', async () => {
    // 発火したインシデントを admin が閉じる
    const incidentId = await raiseIncident(seed.a);
    loginAs(seed.a.tokens.admin);
    const target = await redirectTarget(() =>
      resolveIncident(DASHBOARD_ACTION_INITIAL, form(seed.a.tokens.admin, incidentId)),
    );
    // **印を付けて一覧へ戻る**（解決した行は既定の表示から消えるので、成功は画面側が描く）
    expect(target).toBe(`${INCIDENTS_PATH}?${RESULT_QUERY_NAME}=${RESULT_INCIDENT_RESOLVED}`);
    // 解決済みになっている
    expect(await statusOf(seed.a.id, incidentId)).toBe(IncidentStatus.resolved);
    // **操作として記録されている**（API 経路と同じ操作名を使う）
    expect(await auditActions(seed.a.id)).toEqual([AuditAction.incident_resolved]);
  });

  it('2 度目は「すでに解決済み」と返り、監査ログを増やさない', async () => {
    // 同じインシデントを 2 回閉じる（二重送信・再試行）
    const incidentId = await raiseIncident(seed.a);
    loginAs(seed.a.tokens.admin);
    // 1 度目は成功してリダイレクトする（投げられる例外をここで受け止める）
    await redirectTarget(() =>
      resolveIncident(DASHBOARD_ACTION_INITIAL, form(seed.a.tokens.admin, incidentId)),
    );
    const second = await resolveIncident(
      DASHBOARD_ACTION_INITIAL,
      form(seed.a.tokens.admin, incidentId),
    );
    // 2 度目は断られる
    expect(second.error).toBe(UI_TEXT.incidentAlreadyResolved);
    // **記録は 1 行のまま**（同じ操作を二重に残さない）
    expect(await auditActions(seed.a.id)).toEqual([AuditAction.incident_resolved]);
  });

  // **admin 以外を 1 つずつ見る。** viewer だけを見ていると「operator にも閉じさせる」
  // 変更が素通りする（解決は復帰と同じ重さの操作なので admin 限定。UC-09）
  it.each([Role.viewer, Role.operator])('%s は解決できない', async (role) => {
    // その役割でログインする
    const incidentId = await raiseIncident(seed.a);
    loginAs(seed.a.tokens[role]);
    const state = await resolveIncident(
      DASHBOARD_ACTION_INITIAL,
      form(seed.a.tokens[role], incidentId),
    );
    // 権限が無い旨を返す
    expect(state.error).toBe(UI_TEXT.actionForbidden);
    // **状態は変わらず、監査ログも増えない**
    expect(await statusOf(seed.a.id, incidentId)).toBe(IncidentStatus.open);
    expect(await auditActions(seed.a.id)).toEqual([]);
  });

  it('CSRF トークンが違えば断る', async () => {
    // 別のセッションから導いたトークンを載せる
    const incidentId = await raiseIncident(seed.a);
    loginAs(seed.a.tokens.admin);
    const state = await resolveIncident(
      DASHBOARD_ACTION_INITIAL,
      form(seed.b.tokens.admin, incidentId),
    );
    // 断られ、状態は変わらない
    expect(state.error).toBe(UI_TEXT.actionRejected);
    expect(await statusOf(seed.a.id, incidentId)).toBe(IncidentStatus.open);
  });

  it('他サイトからのフォーム送信は断る（CSRF の 1 枚目）', async () => {
    // Origin が別ホスト。**CSRF トークンは正しい値を載せる**ので、この検査だけが止めている
    const incidentId = await raiseIncident(seed.a);
    loginAs(seed.a.tokens.admin);
    requestHeaders = { origin: 'https://evil.example.com', host: 'ops.example.com' };
    const state = await resolveIncident(
      DASHBOARD_ACTION_INITIAL,
      form(seed.a.tokens.admin, incidentId),
    );
    // 断られ、状態は変わらない
    expect(state.error).toBe(UI_TEXT.actionRejected);
    expect(await statusOf(seed.a.id, incidentId)).toBe(IncidentStatus.open);
  });

  it('未ログインならログイン画面へ送る', async () => {
    // Cookie が無い状態（セッション切れ後に古い画面から押した形）
    const incidentId = await raiseIncident(seed.a);
    const target = await redirectTarget(() =>
      resolveIncident(DASHBOARD_ACTION_INITIAL, form(seed.a.tokens.admin, incidentId)),
    );
    // ログイン画面へ送られる
    expect(target).toBe(LOGIN_PATH);
    expect(await statusOf(seed.a.id, incidentId)).toBe(IncidentStatus.open);
  });

  it('他テナントのインシデントは「見つからない」として断る（存在を漏らさない）', async () => {
    // テナント A の admin がテナント B のインシデント id を送る
    const incidentId = await raiseIncident(seed.b);
    loginAs(seed.a.tokens.admin);
    const state = await resolveIncident(
      DASHBOARD_ACTION_INITIAL,
      form(seed.a.tokens.admin, incidentId),
    );
    // 「見つかりません」だけを返す（403 と 404 を区別すると存在が漏れる。ADR-0002）
    expect(state.error).toBe(UI_TEXT.incidentNotFound);
    // **相手テナントの状態は変わらない**
    expect(await statusOf(seed.b.id, incidentId)).toBe(IncidentStatus.open);
    // 監査ログも増えない（どちらのテナントにも）
    expect(await auditActions(seed.a.id)).toEqual([]);
    expect(await auditActions(seed.b.id)).toEqual([]);
  });

  it('資源 id の形でない値は断る', async () => {
    // パスに入らない形の値を送る
    loginAs(seed.a.tokens.admin);
    const state = await resolveIncident(
      DASHBOARD_ACTION_INITIAL,
      form(seed.a.tokens.admin, 'not an id\u0000'),
    );
    // 断られる（形の定義は src/domain/resource-id.ts の 1 か所）
    expect(state.error).toBe(UI_TEXT.actionRejected);
  });

  it('監査ログの鍵が無ければ状態を変えずに失敗する（fail-closed）', async () => {
    // 鍵を消す（本番で未設定のときと同じ状態）
    const incidentId = await raiseIncident(seed.a);
    loginAs(seed.a.tokens.admin);
    vi.stubEnv('AUDIT_HMAC_SECRET', '');
    // 失敗する（**成功を返さない**ことが要点）
    await expect(
      resolveIncident(DASHBOARD_ACTION_INITIAL, form(seed.a.tokens.admin, incidentId)),
    ).rejects.toThrow();
    // 鍵を戻す
    vi.stubEnv('AUDIT_HMAC_SECRET', AUDIT_SECRET);
    // **状態は変わっていない**（記録の無い変更を残さない。再試行が永久に失敗する形を作らない）
    expect(await statusOf(seed.a.id, incidentId)).toBe(IncidentStatus.open);
  });
});
