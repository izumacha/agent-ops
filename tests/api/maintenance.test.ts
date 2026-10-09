// 保守の定期実行の API テスト（memory アダプタで Route Handler を直接呼ぶ）。
//
// ここで固定するのは 3 つ:
//   1. **入力検証**: 壊れたカーソル・範囲外の予算・未知のキーはすべて 422（本文は閉じている）
//   2. **応答の形**: 進み具合と続きの位置が揃って返る（呼び出し側のループが成り立つ条件）
//   3. **`failed` が 0 でなくても 200**（500 にすると続きのカーソルを渡せず、それ以降が
//      丸ごと判定されない。`POST /guardrails/run` とは逆の判断で、理由はルートのコメント）
//
// 認可（プラットフォーム管理者限定）は tests/api/rbac-endpoints.test.ts が全オペレーション分
// 見るのでここでは繰り返さない。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as runMaintenance } from '@/app/api/v1/maintenance/run/route';
import { API_MESSAGES, MAINTENANCE_AGENT_BUDGET_MAX } from '@/lib/constants';
import { AUDIT_HMAC_SECRET_ENV } from '@/lib/audit/secret';
import type { ApiSchemas } from '@/lib/api-types';
import { call, PLATFORM_TOKEN, seedEachTest } from './helpers';

// seed（2 テナント × 3 役割 + 既存エージェント）
const seed = seedEachTest();

// 監査ログの鍵（下限を満たす固定値。発火したときの記録に要る）
const AUDIT_SECRET = 'maintenance-api-test-audit-secret-012';

/**
 * プラットフォーム管理者として 1 要求送り、応答を**契約の型**で受ける。
 *
 * **`json` は `unknown` なので、ここで 1 回だけ契約の型へ当てる** — テストごとに
 * キャストを書くと、応答の形が変わったときに直す場所が散る（しかも 422 の本文は
 * この形ではないので、ステータスを見るテストは `json` をそのまま読む）
 */
async function post(
  body: Record<string, unknown>,
): Promise<{ status: number; result: ApiSchemas['MaintenanceRunResult']; json: unknown }> {
  // Route Handler を直接呼ぶ
  const res = await call(runMaintenance, { method: 'POST', token: PLATFORM_TOKEN, body });
  // 200 のときだけ意味を持つ型として返す（422 のときは `json` を見る）
  return {
    status: res.status,
    result: res.json as ApiSchemas['MaintenanceRunResult'],
    json: res.json,
  };
}

describe('POST /maintenance/run', () => {
  beforeEach(() => {
    // 監査の鍵を設定する（発火したときに記録できる状態にする）
    vi.stubEnv(AUDIT_HMAC_SECRET_ENV, AUDIT_SECRET);
    // 通知先の設定が無いことを知らせるログを黙らせる
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('本文が空なら一巡を始めて進み具合と続きの位置を返す', async () => {
    // 既定の予算で 1 要求
    const res = await post({});
    // 200 で、応答の形が揃っている
    expect(res.status).toBe(200);
    expect(res.result).toMatchObject({
      rateLimitHitsDeleted: expect.any(Number),
      rateLimitSweepComplete: expect.any(Boolean),
      agentsEvaluated: expect.any(Number),
      rulesEvaluated: expect.any(Number),
      fired: expect.any(Number),
      failed: expect.any(Number),
      passComplete: expect.any(Boolean),
    });
    // seed のエージェント（2 テナント分）を判定し、一巡が終わっている
    expect(res.result.agentsEvaluated).toBeGreaterThan(0);
    expect(res.result.passComplete).toBe(true);
    // 終わっているのでカーソルは両方 null
    expect(res.result.nextTenantCursor).toBeNull();
    expect(res.result.nextAgentCursor).toBeNull();
  });

  it('予算を 1 件にすると続きのカーソルを返す（ループが成り立つ）', async () => {
    // 1 件だけ判定する
    const res = await post({ agentBudget: 1 });
    expect(res.status).toBe(200);
    expect(res.result.agentsEvaluated).toBe(1);
    // まだ終わっていない
    expect(res.result.passComplete).toBe(false);
    // 続きの位置が少なくとも片方は返っている（どちらかは null になりうる）
    expect(res.result.nextTenantCursor !== null || res.result.nextAgentCursor !== null).toBe(true);
  });

  it('返ったカーソルをそのまま送り返すと続きから進む', async () => {
    // 1 件目
    const first = await post({ agentBudget: 1 });
    expect(first.status).toBe(200);
    // 返ったカーソルをそのまま渡す（null は送らない）
    const body: Record<string, unknown> = { agentBudget: 1 };
    if (first.result.nextTenantCursor !== null) body.tenantCursor = first.result.nextTenantCursor;
    if (first.result.nextAgentCursor !== null) body.agentCursor = first.result.nextAgentCursor;
    // 2 件目
    const second = await post(body);
    // 受け付けられている（カーソルの形が往復できている）
    expect(second.status).toBe(200);
  });

  it('壊れたカーソルは 422（形が違う値で DB を引かない）', async () => {
    // base64url として復号できない値
    const res = await post({ tenantCursor: 'not-a-cursor' });
    expect(res.status).toBe(422);
    // 文言はカーソル共通のもの（一覧と同じ）
    expect(JSON.stringify(res.json)).toContain(API_MESSAGES.invalidCursor);
  });

  it('予算が範囲外なら 422（1 要求の長さに上限を置く）', async () => {
    // 0 件（下限未満）
    expect((await post({ agentBudget: 0 })).status).toBe(422);
    // 上限超過
    expect((await post({ agentBudget: MAINTENANCE_AGENT_BUDGET_MAX + 1 })).status).toBe(422);
    // 整数でない
    expect((await post({ agentBudget: 1.5 })).status).toBe(422);
  });

  it('未知のキーは 422（本文は閉じている）', async () => {
    // 綴りを間違えた指定が黙って無視されない
    expect((await post({ agentBudgets: 10 })).status).toBe(422);
  });

  it('判定が失敗しても 200 で続きのカーソルを返す（ループを止めない）', async () => {
    // 有効ルールの読み出しを必ず失敗させる
    vi.spyOn(seed.repos.guardrailRules, 'findActiveRules').mockRejectedValue(
      new Error('読み出しに失敗'),
    );
    // 1 要求
    const res = await post({});
    // 200 のまま、失敗した件数が応答に出る
    expect(res.status).toBe(200);
    expect(res.result.failed).toBeGreaterThan(0);
    // 一巡は回り切る（止まらない）
    expect(res.result.passComplete).toBe(true);
  });
});
