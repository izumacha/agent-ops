// 課金の 2 本（`GET /billing` と `POST /billing/webhook`）の API テスト。
//
// **受け入れ基準②「Webhook 冪等性テスト pass」の本体がここ。** テスト名の接頭辞
// `冪等性:` は `scripts/gate-step6.mjs` が照合するので変えない（料金表・RBAC 行列と同じ流儀で、
// ゲートは「その名前のテストが pass しているか」を見る）。
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GET as getBilling } from '@/app/api/v1/billing/route';
import { PATCH as updateTenantPlan } from '@/app/api/v1/tenants/[tenantId]/route';
import { POST as receiveBillingWebhook } from '@/app/api/v1/billing/webhook/route';
import { BILLING_SIGNATURE_HEADER } from '@/lib/billing/signature';
import { BILLING_PRICE_LOOKUP_KEYS } from '@/lib/billing/events';
import { PLAN_FEATURES, PLAN_LIMITS, planAllows } from '@/domain/plan';
import { Plan } from '@/domain/types';
import { API_MESSAGES } from '@/lib/constants';
import { BILLING_SECRET, PLATFORM_TOKEN, call, seedEachTest } from './helpers';
import { GET as listAuditLogs } from '@/app/api/v1/audit-logs/route';
import { AuditAction, AuditTargetType } from '@/domain/audit/action';
import { PLAN_CHANGE_SOURCE } from '@/lib/billing/apply-plan';

// seed（各テストの前に作り直す）
const seed = seedEachTest();

// 価格の名前（表から引く。綴りを書き写さない）
const PRICE_BY_PLAN = Object.fromEntries(
  Object.entries(BILLING_PRICE_LOOKUP_KEYS).map(([lookupKey, plan]) => [plan, lookupKey]),
) as Record<Plan, string>;

// 受信イベントの本文を組み立てる
function webhookBody(options: {
  eventId?: string;
  type?: string;
  customer?: string | null;
  plan?: Plan;
  // `null` を渡すと `data.object.id` を**省いた**本文になる（事業者が ID を運ばない再送の形）
  subscriptionId?: string | null;
}): Record<string, unknown> {
  return {
    id: options.eventId ?? 'evt_1',
    type: options.type ?? 'customer.subscription.updated',
    data: {
      object: {
        id: options.subscriptionId === undefined ? 'sub_1' : (options.subscriptionId ?? undefined),
        customer: options.customer === undefined ? 'cus_1' : options.customer,
        items:
          options.plan === undefined
            ? undefined
            : { data: [{ price: { lookup_key: PRICE_BY_PLAN[options.plan] } }] },
      },
    },
  };
}

// 生のテキストに正しい署名を付けて受信 Webhook を呼ぶ（署名の対象は本文そのもの）
async function postRaw(raw: string, secret = BILLING_SECRET) {
  // 署名の時刻（いまの秒）
  const timestamp = Math.floor(Date.now() / 1_000);
  // 署名
  const signature = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  // ヘッダを付けて呼ぶ
  return call(receiveBillingWebhook, {
    method: 'POST',
    rawBody: raw,
    headers: {
      'content-type': 'application/json',
      [BILLING_SIGNATURE_HEADER]: `t=${timestamp},v1=${signature}`,
    },
  });
}

// 組み立てた本文に正しい署名を付けて呼ぶ
async function postWebhook(body: Record<string, unknown>, secret = BILLING_SECRET) {
  // JSON 化してから署名する（解析して組み立て直すと署名が一致しない）
  return postRaw(JSON.stringify(body), secret);
}

// テナント A を顧客 ID と結び付ける（Webhook がテナントを引けるようにする）
async function linkCustomer(customerId = 'cus_1'): Promise<void> {
  // プランは変えずに顧客 ID だけ入れる
  await seed.repos.tenants.updatePlan(seed.a.id, {
    plan: Plan.free,
    billingCustomerId: customerId,
  });
}

// テナント A を**プラットフォーム管理者の API 経由で**顧客 ID と結び付ける。
// **データ層を直接触らない** — 連携を作る経路が API に無いと、事業者からのイベントは
// 永久に反映されない（実際この経路が無く、`findByBillingCustomerId` が常に null を返していた）
async function linkCustomerViaApi(customerId: string, plan: Plan = Plan.free) {
  // PATCH /tenants/{tenantId}（プラットフォーム管理者専用）
  return call(updateTenantPlan, {
    method: 'PATCH',
    token: PLATFORM_TOKEN,
    params: { tenantId: seed.a.id },
    body: { plan, billingCustomerId: customerId },
  });
}

// テナント A の課金連携（顧客 ID / サブスクリプション ID）を読む
async function billingLinkOfA(): Promise<{
  billingCustomerId: string | null;
  billingSubscriptionId: string | null;
} | null> {
  // 行を引いて 2 列だけ返す
  const tenant = await seed.repos.tenants.findById(seed.a.id);
  return tenant === null
    ? null
    : {
        billingCustomerId: tenant.billingCustomerId,
        billingSubscriptionId: tenant.billingSubscriptionId,
      };
}

// テナント A の現在のプランを読む
async function planOfA(): Promise<Plan | undefined> {
  // 行を引いてプランを返す
  return (await seed.repos.tenants.findById(seed.a.id))?.plan;
}

describe('GET /billing', () => {
  it('現在のプランと上限・機能の可否を返す', async () => {
    // seed は pro（helpers.ts）
    const result = await call(getBilling, { token: seed.a.tokens.viewer });
    expect(result.status).toBe(200);
    // **表の値をそのまま返す**（数値を書き写さない）
    const limits = PLAN_LIMITS[Plan.pro];
    expect(result.json).toEqual({
      plan: Plan.pro,
      limits: {
        maxAgents: limits.maxAgents,
        proxyRateLimitPerMinute: limits.proxyRateLimitPerMinute,
        maxEnabledGuardrailRules: limits.maxEnabledGuardrailRules,
      },
      // 機能の可否は宣言した機能の一覧から導く
      features: Object.fromEntries(
        PLAN_FEATURES.map((feature) => [feature, planAllows(Plan.pro, feature)]),
      ),
    });
  });

  it.each(Object.values(Plan))('%s のテナントはそのプランの上限を返す', async (plan) => {
    // プランを差し替えてから読む（プランを読まず固定値を返す変異はここで落ちる）
    const tenant = seed.store.tenants.get(seed.a.id);
    if (!tenant) throw new Error('テナント行が見つかりません');
    seed.store.tenants.set(tenant.id, { ...tenant, plan });
    const result = await call(getBilling, { token: seed.a.tokens.viewer });
    expect(result.json).toMatchObject({
      plan,
      limits: { maxAgents: PLAN_LIMITS[plan].maxAgents },
    });
  });

  it('他テナントのプランは見えない（自分のテナントの値だけ）', async () => {
    // B を enterprise にしても A の応答は変わらない（ADR-0002 の行スコープ）
    const b = seed.store.tenants.get(seed.b.id);
    if (!b) throw new Error('テナント行が見つかりません');
    seed.store.tenants.set(b.id, { ...b, plan: Plan.enterprise });
    const result = await call(getBilling, { token: seed.a.tokens.viewer });
    expect(result.json).toMatchObject({ plan: Plan.pro });
  });
});

describe('POST /billing/webhook', () => {
  it('署名が正しければプランを反映する', async () => {
    // 顧客 ID を結び付けてから pro への変更を送る
    await linkCustomer();
    const result = await postWebhook(webhookBody({ plan: Plan.pro }));
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ received: true, applied: true });
    // プランが変わっている
    expect(await planOfA()).toBe(Plan.pro);
  });

  it('解約イベントは free へ落とす', async () => {
    // pro にしてから解約を送る
    await linkCustomer();
    await seed.repos.tenants.updatePlan(seed.a.id, { plan: Plan.enterprise });
    const result = await postWebhook(
      webhookBody({ type: 'customer.subscription.deleted', eventId: 'evt_del' }),
    );
    expect(result.json).toEqual({ received: true, applied: true });
    expect(await planOfA()).toBe(Plan.free);
  });

  it('サブスクリプション ID も一緒に保存する', async () => {
    // プランと id を同時に書く（別の操作に分けると片方だけ成功した状態が残る）
    await linkCustomer();
    await postWebhook(webhookBody({ plan: Plan.pro, subscriptionId: 'sub_xyz' }));
    expect((await seed.repos.tenants.findById(seed.a.id))?.billingSubscriptionId).toBe('sub_xyz');
  });

  it.each([
    ['署名ヘッダが無い', {}],
    ['署名が壊れている', { [BILLING_SIGNATURE_HEADER]: 't=1,v1=' + 'a'.repeat(64) }],
    ['形が違う', { [BILLING_SIGNATURE_HEADER]: 'nonsense' }],
  ])('署名が確認できなければ 401 で何も変えない: %s', async (_label, headers) => {
    // 顧客 ID は結び付けておく（弾かれる理由が署名だけになるように）
    await linkCustomer();
    // 署名を付けずに（あるいは壊れた署名で）呼ぶ
    const result = await call(receiveBillingWebhook, {
      method: 'POST',
      rawBody: JSON.stringify(webhookBody({ plan: Plan.enterprise })),
      headers: { 'content-type': 'application/json', ...headers },
    });
    expect(result.status).toBe(401);
    expect(result.json).toMatchObject({ message: API_MESSAGES.billingSignatureInvalid });
    // プランは変わっていない
    expect(await planOfA()).toBe(Plan.free);
  });

  it('別の鍵で署名した本文は 401（鍵を知らない相手は通れない）', async () => {
    // **これが通ると誰でも任意のテナントを enterprise へ上げられる**
    await linkCustomer();
    const result = await postWebhook(
      webhookBody({ plan: Plan.enterprise }),
      'another-secret-0123456789abcdefghij',
    );
    expect(result.status).toBe(401);
    expect(await planOfA()).toBe(Plan.free);
  });

  it('共有シークレットが未設定なら 503（検証を飛ばして受け入れない）', async () => {
    // 鍵を消す（この経路を主題にするテストだけが明示的に消す）
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', '');
    await linkCustomer();
    const result = await postWebhook(webhookBody({ plan: Plan.enterprise }));
    expect(result.status).toBe(503);
    expect(await planOfA()).toBe(Plan.free);
    // 後片付け
    vi.unstubAllEnvs();
  });

  it('顧客 ID に対応するテナントが無ければ記録だけして 200', async () => {
    // 結び付けていない顧客からのイベント（記録しないと再送のたびに同じ処理を繰り返す）
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await postWebhook(webhookBody({ plan: Plan.pro, customer: 'cus_unknown' }));
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ received: true, applied: false });
    // **黙って捨てない**（設定の取り違えに気付けるようログへ 1 行残す）
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it('顧客 ID が無い本文も記録だけして 200', async () => {
    // customer が null のイベント（どのテナントか決められない）
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await postWebhook(webhookBody({ plan: Plan.pro, customer: null }));
    expect(result.json).toEqual({ received: true, applied: false });
    logged.mockRestore();
  });

  it('知らない種別は何もせず 200（ログも出さない）', async () => {
    // 契約と無関係な通知（エラーにすると事業者が再送を続ける）
    await linkCustomer();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await postWebhook(
      webhookBody({ type: 'invoice.payment_succeeded', plan: Plan.enterprise }),
    );
    expect(result.json).toEqual({ received: true, applied: false });
    expect(await planOfA()).toBe(Plan.free);
    // 無関係な通知でログを汚さない
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it('知らない価格は反映せず 200（勝手に free へ落とさない）', async () => {
    // pro のテナントへ、表に無い価格の変更が届いた形
    await linkCustomer();
    await seed.repos.tenants.updatePlan(seed.a.id, { plan: Plan.pro });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    // 価格だけ表に無い本文（署名は正しく付ける）
    const result = await postRaw(
      JSON.stringify({
        id: 'evt_price',
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_1',
            items: { data: [{ price: { lookup_key: 'unknown-price' } }] },
          },
        },
      }),
    );
    expect(result.json).toEqual({ received: true, applied: false });
    // **プランは pro のまま**（払っているテナントが機能を失わない）
    expect(await planOfA()).toBe(Plan.pro);
    // 契約の変更イベントなので、決められなかったことはログに残す
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('反映は監査ログに残る（経路が webhook であることも）', async () => {
    // **人の操作と同じ名前・同じ形で残す**（別々に書くと監査ログを読む側が 2 つの操作として数える）
    await linkCustomer();
    await postWebhook(webhookBody({ plan: Plan.enterprise }));
    // そのテナントの admin で監査ログを読む
    const logs = await call(listAuditLogs, { token: seed.a.tokens.admin });
    const items = (logs.json as { items: { action: string; payload: unknown }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      action: AuditAction.tenant_plan_changed,
      targetType: AuditTargetType.tenant,
      // Webhook 由来なので actorId は無い（経路は payload の source が示す）
      actorId: null,
      payload: { from: Plan.free, to: Plan.enterprise, source: PLAN_CHANGE_SOURCE.webhook },
    });
  });

  it('監査ログの鍵が無ければ 503 で、受信記録も残さない', async () => {
    // **記録してから反映に失敗すると、再送は「2 通目」として無視され永久に反映されない。**
    // 鍵が無いなら 1 行も記録せず 503 を返し、事業者の再送でやり直させる
    await linkCustomer();
    vi.stubEnv('AUDIT_HMAC_SECRET', '');
    const body = webhookBody({ plan: Plan.pro, eventId: 'evt_no_audit' });
    expect((await postWebhook(body)).status).toBe(503);
    // 鍵を戻すと、同じイベントがやり直せる（記録が残っていれば duplicate で無視されてしまう）
    vi.unstubAllEnvs();
    expect((await postWebhook(body)).json).toEqual({ received: true, applied: true });
    expect(await planOfA()).toBe(Plan.pro);
  });

  it('共有キャッシュへ載らない（no-store を宣言している）', async () => {
    // `route()` を通らない経路なので、ヘッダの付け忘れがここでしか見えない
    await linkCustomer();
    const result = await postWebhook(webhookBody({ plan: Plan.pro }));
    expect(result.headers.get('Cache-Control')).toContain('no-store');
  });

  it('連携: プラットフォーム管理者が結び付けた顧客 ID で Webhook がテナントを引ける', async () => {
    // **API だけで端から端まで通す。** 連携を作る経路が無いと、署名が正しくても
    // `findByBillingCustomerId` が null を返して永久に `applied: false` になる
    expect((await linkCustomerViaApi('cus_link')).status).toBe(200);
    // その顧客 ID を名乗るイベントが反映される
    const result = await postWebhook(webhookBody({ customer: 'cus_link', plan: Plan.enterprise }));
    expect(result.json).toEqual({ received: true, applied: true });
    expect(await planOfA()).toBe(Plan.enterprise);
  });

  it('連携: 顧客 ID を省いた変更は既存の連携を消さない', async () => {
    // 先に結び付ける
    await linkCustomerViaApi('cus_keep');
    // プランだけを変える（項目を省く = 据え置き）
    expect(
      (
        await call(updateTenantPlan, {
          method: 'PATCH',
          token: PLATFORM_TOKEN,
          params: { tenantId: seed.a.id },
          body: { plan: Plan.pro },
        })
      ).status,
    ).toBe(200);
    // 連携は残っているので、同じ顧客 ID のイベントが届く
    expect((await billingLinkOfA())?.billingCustomerId).toBe('cus_keep');
    expect(
      (await postWebhook(webhookBody({ customer: 'cus_keep', plan: Plan.free }))).json,
    ).toEqual({ received: true, applied: true });
  });

  it('連携: null を渡すと連携を外す（以降のイベントは反映しない）', async () => {
    // 結び付けてから外す
    await linkCustomerViaApi('cus_drop');
    await call(updateTenantPlan, {
      method: 'PATCH',
      token: PLATFORM_TOKEN,
      params: { tenantId: seed.a.id },
      body: { plan: Plan.free, billingCustomerId: null },
    });
    expect((await billingLinkOfA())?.billingCustomerId).toBeNull();
    // 引けないので受け取るだけ（記録は残す）
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await postWebhook(webhookBody({ customer: 'cus_drop', plan: Plan.pro }))).json).toEqual(
      {
        received: true,
        applied: false,
      },
    );
    expect(await planOfA()).toBe(Plan.free);
    logged.mockRestore();
  });

  it('サブスクリプション ID を運ばない再送で既存の連携を消さない', async () => {
    // **Port の `null` は「連携を外す」という明示の指示**なので、本文に ID が無いだけで
    // 渡してしまうと、正しい署名の再送 1 通で連携が消える（以降の解約イベントを紐付けられない）
    await linkCustomerViaApi('cus_1');
    await postWebhook(webhookBody({ plan: Plan.pro, subscriptionId: 'sub_keep' }));
    expect((await billingLinkOfA())?.billingSubscriptionId).toBe('sub_keep');
    // `data.object.id` を省いた本文（スキーマは nullish なので妥当）
    const result = await postWebhook(
      webhookBody({ eventId: 'evt_no_sub', plan: Plan.enterprise, subscriptionId: null }),
    );
    expect(result.json).toEqual({ received: true, applied: true });
    // プランは変わり、連携は残る
    expect(await planOfA()).toBe(Plan.enterprise);
    expect((await billingLinkOfA())?.billingSubscriptionId).toBe('sub_keep');
  });

  it('署名が無ければ本文が壊れていても 401（署名より前に解析しない）', async () => {
    // **順序の検査。** 解析を先に置くと、未認証の相手が 400 / 422 と 401 の出方の違いから
    // 受け付ける本文の形を探れるうえ、解析の費用まで払わせることになる
    const result = await call(receiveBillingWebhook, {
      method: 'POST',
      rawBody: '{壊れた JSON',
      headers: { 'content-type': 'application/json' },
    });
    expect(result.status).toBe(401);
    expect(result.json).toMatchObject({ message: API_MESSAGES.billingSignatureInvalid });
  });

  it('冪等性: 同じイベントの 2 通目は何もせず 200 を返す', async () => {
    // 1 通目で pro へ上げる
    await linkCustomer();
    const body = webhookBody({ plan: Plan.pro, eventId: 'evt_same' });
    expect((await postWebhook(body)).json).toEqual({ received: true, applied: true });
    // **手で free へ戻してから 2 通目を送る** — 2 通目が処理されていれば pro に戻ってしまう
    await seed.repos.tenants.updatePlan(seed.a.id, { plan: Plan.free });
    const second = await postWebhook(body);
    expect(second.status).toBe(200);
    expect(second.json).toEqual({ received: true, applied: false });
    // 反映されていない（= 2 通目は何もしていない）
    expect(await planOfA()).toBe(Plan.free);
  });

  it('冪等性: 同時に届いた 2 通でも反映は 1 回だけ', async () => {
    // **「処理済みか先に SELECT してから INSERT」の形との差が出るのはここ**
    await linkCustomer();
    const body = webhookBody({ plan: Plan.pro, eventId: 'evt_race' });
    // 2 通を同時に投げる
    const [first, second] = await Promise.all([postWebhook(body), postWebhook(body)]);
    // どちらも 200 で、反映したのは片方だけ
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const applied = [first, second].filter(
      (result) => (result.json as { applied: boolean }).applied,
    );
    expect(applied).toHaveLength(1);
  });

  it('冪等性: イベント ID が違えば 2 通目も反映する', async () => {
    // 冪等性が「全部無視する」に化けていないこと（緩すぎない検査）
    await linkCustomer();
    expect(
      (await postWebhook(webhookBody({ plan: Plan.pro, eventId: 'evt_a' }))).json,
    ).toMatchObject({ applied: true });
    expect(
      (await postWebhook(webhookBody({ plan: Plan.enterprise, eventId: 'evt_b' }))).json,
    ).toMatchObject({ applied: true });
    // 2 通目のプランが効いている
    expect(await planOfA()).toBe(Plan.enterprise);
  });

  it('冪等性: 署名が確認できなかった要求は記録しない（記録を使い切らせない）', async () => {
    // **弾いた要求を記録すると、攻撃者が任意のイベント ID を「処理済み」にできる** —
    // 本物の通知がその ID で届いても 2 通目として無視され、プランが永久に反映されない
    await linkCustomer();
    const body = webhookBody({ plan: Plan.pro, eventId: 'evt_poison' });
    // 署名なしで弾かれる
    const refused = await call(receiveBillingWebhook, {
      method: 'POST',
      rawBody: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
    expect(refused.status).toBe(401);
    // 同じイベント ID の正しい署名付きの通知は普通に反映される
    expect((await postWebhook(body)).json).toEqual({ received: true, applied: true });
    expect(await planOfA()).toBe(Plan.pro);
  });
});
