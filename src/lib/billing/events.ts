// 受信した課金イベントを「このテナントのプランをどうするか」へ写す（Step6）。
//
// **知らないものは何もしない。** 事業者は契約と無関係なイベントも大量に送るので、
// 「知らない種別・知らない価格」は**無視して 200 を返す**（エラーにすると事業者が再送を続け、
// いつまでも配信待ちが溜まる）。ただし**黙って捨てない** — 価格が読めない場合だけは
// 「有料のつもりの契約が反映されていない」状態なので、サーバログに 1 行残す。
import { Plan } from '@/domain/types';
import type { BillingWebhookEvent } from '@/lib/validations/billing';

/**
 * 受信イベントの種別 → 反映の仕方 の**網羅的な表**。
 *
 * - `'fromPrice'`: 本文の価格（`lookup_key`）からプランを決める（契約の開始・変更）
 * - `'toFree'`: 無料プランへ落とす（解約）
 *
 * **表に無い種別は無視する**（`null` を返す）。`switch` で書き下すと、種別を足したときに
 * 「どれにも当たらない」のか「書き忘れた」のかが区別できない。
 */
export const BILLING_EVENT_EFFECT = {
  'customer.subscription.created': 'fromPrice',
  'customer.subscription.updated': 'fromPrice',
  'customer.subscription.deleted': 'toFree',
} as const satisfies Record<string, 'fromPrice' | 'toFree'>;

/** 反映の仕方（上の表の値） */
export type BillingEventEffect = (typeof BILLING_EVENT_EFFECT)[keyof typeof BILLING_EVENT_EFFECT];

/**
 * 価格の `lookup_key` → プラン の表。
 *
 * **事業者側のダッシュボードで設定する値と揃える必要がある**ので、ここが唯一の参照元
 * （ドキュメントはこの名前を指す）。**知らない `lookup_key` は無視する** — 勝手に `free` へ
 * 落とすと、価格の名前を変えただけで有料のテナントが機能を失う（倒れる向きを間違えると
 * 「払っているのに使えない」になる）。
 */
export const BILLING_PRICE_LOOKUP_KEYS: Readonly<Record<string, Plan>> = {
  'agent-ops-free': Plan.free,
  'agent-ops-pro': Plan.pro,
  'agent-ops-enterprise': Plan.enterprise,
};

/** イベントから決まった「反映すべきプラン」（決められなければ `null`） */
export interface BillingPlanChange {
  // 反映後のプラン
  plan: Plan;
  // 事業者側のサブスクリプション ID（紐付けを保つために一緒に書く。無ければ null）
  subscriptionId: string | null;
}

/**
 * イベントから反映すべきプランを決める。決められなければ `null`（= 何もしない）。
 *
 * **`null` の意味は 2 つあるが、どちらも「何もしない」で同じ**: 知らない種別（契約と無関係な
 * 通知）と、知らない価格（表の更新漏れ）。後者は運用の誤りなので呼び出し側がログに残す。
 */
export function planChangeFor(event: BillingWebhookEvent): BillingPlanChange | null {
  // 種別が表にあるか（**自身のキーとして**見る。素の添字だと `constructor` 等が値を返す）
  if (!Object.hasOwn(BILLING_EVENT_EFFECT, event.type)) return null;
  // 反映の仕方
  const effect = BILLING_EVENT_EFFECT[event.type as keyof typeof BILLING_EVENT_EFFECT];
  // サブスクリプション ID（本文に無ければ null）
  const subscriptionId = event.data.object.id ?? null;
  // 解約は無料プランへ落とす（価格を見ない — 消えた契約の価格は意味を持たない）
  if (effect === 'toFree') return { plan: Plan.free, subscriptionId };
  // 価格の lookup_key を取り出す（最初の明細だけを見る。1 契約 1 プランの前提）
  const lookupKey = event.data.object.items?.data?.[0]?.price?.lookup_key ?? null;
  // 価格が無い・表に無いなら決められない（呼び出し側がログに残す）
  if (lookupKey === null || !Object.hasOwn(BILLING_PRICE_LOOKUP_KEYS, lookupKey)) return null;
  // 表のプランへ反映する
  return { plan: BILLING_PRICE_LOOKUP_KEYS[lookupKey], subscriptionId };
}

/**
 * その種別が「価格からプランを決めるはずの種別」か（＝ `planChangeFor` が `null` を返したら
 * 設定の取り違え）。
 *
 * **表から導く**（写しを持たない）。これが無いと、呼び出し側が「ログに残すべき種別」の一覧を
 * もう 1 つ持つことになり、種別を足したときに片方だけが古くなる（§6）。
 */
export function isPlanChangeEvent(type: string): boolean {
  // 表に無い種別は契約と無関係なので、決められなくても異常ではない
  if (!Object.hasOwn(BILLING_EVENT_EFFECT, type)) return false;
  // 価格から決める種別だけが「決められないのは異常」
  return BILLING_EVENT_EFFECT[type as keyof typeof BILLING_EVENT_EFFECT] === 'fromPrice';
}
