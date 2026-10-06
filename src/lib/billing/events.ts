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
 * 契約の状態（`status`）→ 反映の仕方 の表。
 *
 * **価格だけでプランを決めてはいけない。** 価格（`lookup_key`）は「どのプランの契約か」しか
 * 示さないので、状態を見ないと次の 2 つが通る:
 *
 * - **払っていない契約で有料プランが付く** — Stripe の推奨フロー（`payment_behavior:
 *   'default_incomplete'`）や 3DS を途中で閉じた場合、`customer.subscription.created` は
 *   `status: 'incomplete'` で届くが価格は enterprise のまま。
 * - **解約したのに有料へ戻る** — 1 回の解約で `customer.subscription.updated`
 *   （`status: 'canceled'`・価格は pro のまま）と `customer.subscription.deleted` の
 *   **2 通**が届き、**配信順は保証されない**（失敗した配信は最大 3 日再送される）。
 *   `deleted` を先に処理すると free になり、その後に届いた `updated` が価格から pro へ戻す。
 *
 * - `'fromPrice'`: 価格からプランを決める（支払いが有効な状態）
 * - `'toFree'`: 無料プランへ落とす（契約が終わっている状態）
 * - `'ignore'`: 何もしない（**まだ有効でないだけ**。既存の契約を取り消さない）
 *
 * **`past_due` は据え置き**（支払いの再試行中に機能を止めると、一時的なカード失敗で
 * 払っている利用者を切ることになる）。**`unpaid` は再試行が尽きた後の状態なので落とす**。
 * **表に無い状態は `'ignore'`**（権限を増やさない側へ倒す。`planChangeFor` が `null` を返すので
 * 呼び出し側がログに残す）。
 */
export const BILLING_SUBSCRIPTION_STATUS_EFFECT = {
  // 支払いが有効（通常の有料契約）
  active: 'fromPrice',
  // 試用期間中（Stripe 上は有効な契約なので機能は開ける）
  trialing: 'fromPrice',
  // 支払いの再試行中（据え置き。止めるのは再試行が尽きた `unpaid` から）
  past_due: 'fromPrice',
  // 解約済み
  canceled: 'toFree',
  // 再試行が尽きて未払い
  unpaid: 'toFree',
  // 事業者側で停止された契約
  paused: 'toFree',
  // 初回の支払いが完了していない（**まだ有効でないだけ**なので既存の契約を取り消さない）
  incomplete: 'ignore',
  // 初回の支払いが期限切れで失効した（同上。解約は `deleted` / `canceled` が示す）
  incomplete_expired: 'ignore',
} as const satisfies Record<string, 'fromPrice' | 'toFree' | 'ignore'>;

/** 状態から反映の仕方を引く純粋関数（表に無い状態・未指定は `'ignore'`） */
export function subscriptionStatusEffect(
  status: string | null | undefined,
): 'fromPrice' | 'toFree' | 'ignore' {
  // 状態が無ければ判断できない（権限を増やさない側へ倒す）
  if (status === null || status === undefined) return 'ignore';
  // 表に**自身のキーとして**あるものだけを信用する（素の添字だと `constructor` 等が値を返す）
  if (!Object.hasOwn(BILLING_SUBSCRIPTION_STATUS_EFFECT, status)) return 'ignore';
  // 表の値
  return BILLING_SUBSCRIPTION_STATUS_EFFECT[
    status as keyof typeof BILLING_SUBSCRIPTION_STATUS_EFFECT
  ];
}

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
  // **価格を見る前に契約の状態を見る**（理由は BILLING_SUBSCRIPTION_STATUS_EFFECT）
  const byStatus = subscriptionStatusEffect(event.data.object.status);
  // まだ有効でない・判断できない状態は何もしない（既存の契約を取り消さない）
  if (byStatus === 'ignore') return null;
  // 終わっている状態は価格を見ずに無料プランへ落とす（解約の 2 通目が有料へ戻すのを防ぐ）
  if (byStatus === 'toFree') return { plan: Plan.free, subscriptionId };
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
