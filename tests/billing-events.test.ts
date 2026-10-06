// 受信イベント → プラン の写像（`src/lib/billing/events.ts`）の境界。
//
// 固定するのは 3 系統:
//   1. 表のとおりに写すこと（種別 × 価格の全組を表から導く）
//   2. **知らないものは何もしない**（勝手に free へ落とさない — 落とすと払っているテナントが
//      価格の名前を変えただけで機能を失う）
//   3. プロトタイプ由来の名前（`constructor` 等）で表を素通りしないこと
import { describe, expect, it } from 'vitest';
import {
  BILLING_EVENT_EFFECT,
  BILLING_PRICE_LOOKUP_KEYS,
  isPlanChangeEvent,
  planChangeFor,
} from '@/lib/billing/events';
import { Plan } from '@/domain/types';
import type { BillingWebhookEvent } from '@/lib/validations/billing';

// 受信イベントを組み立てる（読む項目だけを埋める）
function event(options: {
  type: string;
  lookupKey?: string | null;
  subscriptionId?: string | null;
}): BillingWebhookEvent {
  return {
    id: 'evt_1',
    type: options.type,
    data: {
      object: {
        // `null` を渡したときは本当に null にする（`??` だと既定値へ戻ってしまう）
        id: options.subscriptionId === undefined ? 'sub_1' : options.subscriptionId,
        customer: 'cus_1',
        items:
          options.lookupKey === undefined
            ? undefined
            : { data: [{ price: { lookup_key: options.lookupKey } }] },
      },
    },
  } as BillingWebhookEvent;
}

describe('イベントからプランへの写像', () => {
  it.each(
    // 「価格から決める種別」× 「表にある価格」の全組を導く（写しを持たない）
    Object.entries(BILLING_EVENT_EFFECT)
      .filter(([, effect]) => effect === 'fromPrice')
      .flatMap(([type]) =>
        Object.entries(BILLING_PRICE_LOOKUP_KEYS).map(
          ([lookupKey, plan]) => [type, lookupKey, plan] as const,
        ),
      ),
  )('%s × %s は %s へ写す', (type, lookupKey, plan) => {
    // 表のプランへ反映する
    expect(planChangeFor(event({ type, lookupKey }))).toEqual({
      plan,
      subscriptionId: 'sub_1',
    });
  });

  it('解約は価格を見ずに free へ落とす', () => {
    // 消えた契約の価格は意味を持たないので読まない（価格が無い本文でも free になること）
    expect(planChangeFor(event({ type: 'customer.subscription.deleted' }))).toEqual({
      plan: Plan.free,
      subscriptionId: 'sub_1',
    });
  });

  it('知らない種別は何もしない', () => {
    // 事業者は契約と無関係な種別も大量に送る（無視して 200 を返す側）
    expect(
      planChangeFor(event({ type: 'invoice.payment_succeeded', lookupKey: 'agent-ops-pro' })),
    ).toBeNull();
  });

  it('知らない価格は何もしない（勝手に free へ落とさない）', () => {
    // **倒れる向きを間違えると「払っているのに使えない」になる**
    expect(
      planChangeFor(event({ type: 'customer.subscription.updated', lookupKey: 'unknown-price' })),
    ).toBeNull();
  });

  it('価格が無い・null でも何もしない', () => {
    // 明細が無い本文（契約の変更のはずなのに価格が読めない形）
    expect(planChangeFor(event({ type: 'customer.subscription.updated' }))).toBeNull();
    expect(
      planChangeFor(event({ type: 'customer.subscription.updated', lookupKey: null })),
    ).toBeNull();
  });

  it('プロトタイプ由来の名前で表を素通りしない', () => {
    // 素の添字だと `constructor` が Object 由来の値を返し、判定が壊れる
    expect(planChangeFor(event({ type: 'constructor', lookupKey: 'agent-ops-pro' }))).toBeNull();
    expect(
      planChangeFor(event({ type: 'customer.subscription.updated', lookupKey: 'constructor' })),
    ).toBeNull();
  });

  it('サブスクリプション ID が無ければ null で返す（紐付けを消さない）', () => {
    // `updatePlan` は null を「未連携へ戻す」と解釈するので、本文に無いことが伝わる形で返す
    expect(
      planChangeFor(
        event({
          type: 'customer.subscription.updated',
          lookupKey: 'agent-ops-pro',
          subscriptionId: null,
        }),
      ),
    ).toEqual({ plan: Plan.pro, subscriptionId: null });
  });
});

describe('ログに残すべき種別の判定', () => {
  it.each(Object.entries(BILLING_EVENT_EFFECT))('%s は %s の扱い', (type, effect) => {
    // 「価格から決める種別」だけが「決められないのは異常」（表から導く）
    expect(isPlanChangeEvent(type)).toBe(effect === 'fromPrice');
  });

  it('表に無い種別は異常ではない', () => {
    // 契約と無関係な通知なので、決められなくてもログに残さない
    expect(isPlanChangeEvent('invoice.payment_succeeded')).toBe(false);
    // プロトタイプ由来の名前も同じ
    expect(isPlanChangeEvent('constructor')).toBe(false);
  });
});

describe('価格の表', () => {
  it('全プランを網羅する（プランを足して価格の登録を忘れたら落ちる）', () => {
    // 表の値の集合と enum の集合が一致すること（登録を忘れたプランは Webhook で反映されない）
    expect(new Set(Object.values(BILLING_PRICE_LOOKUP_KEYS))).toEqual(new Set(Object.values(Plan)));
  });
});
