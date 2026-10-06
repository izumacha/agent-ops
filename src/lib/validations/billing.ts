// 受信 Webhook の本文の検証（Step6）。
//
// **`z.strictObject` にしない。** 本文は事業者（Stripe）が作るペイロードで、こちらの知らない項目が
// 普通に入っている（プロキシが中継する本文と同じ扱い。`tests/openapi.test.ts` の除外表に理由付きで
// 登録してある）。未知のキーを拒否すると、事業者が項目を 1 つ増やした日に全イベントが 422 になり、
// プランの反映が止まる。**読むのは必要な項目だけ**で、それ以外は通過させる。
//
// 読む項目は「どのイベントか（id / type）」「どの顧客か（customer）」「どのプランか（価格の
// lookup_key）」だけ。金額・税・請求書などは**読まない**（読まない値は保存もしない）。
import { z } from './zod';
import { BILLING_WEBHOOK_FIELD_MAX_LENGTH } from '@/lib/constants';

// 事業者側の識別子（`evt_...` / `cus_...` / `sub_...`）。**長さの上限を置く**（§9 の入力検証。
// 上限が無いと、1 本文で任意の長さの文字列を DB の列へ渡すことになる）
const billingId = z.string().min(1).max(BILLING_WEBHOOK_FIELD_MAX_LENGTH);

/**
 * 受信イベントの本文。
 *
 * **`data.object` の形は契約の種別ごとに違う**ので、プランの判定に要る枝だけを省略可として読む
 * （`items.data[0].price.lookup_key`）。読めなければ `planChangeFor` が `null` を返し、
 * 呼び出し側が「反映しない」を選ぶ（§9 の「壊れたデータでクラッシュさせず、不正値はフォールバック」）。
 */
export const billingWebhookEventSchema = z.object({
  // 事業者側のイベント ID（冪等性のキー）
  id: billingId,
  // イベント種別（例: customer.subscription.updated）
  type: z.string().min(1).max(BILLING_WEBHOOK_FIELD_MAX_LENGTH),
  // イベントの対象
  data: z.object({
    object: z.object({
      // 対象そのものの ID（サブスクリプションなら sub_...）
      id: billingId.nullish(),
      // 顧客 ID（これでテナントを引く。無ければどのテナントか決められない）
      customer: billingId.nullish(),
      // 契約の明細（プランの判定に使う最初の 1 件だけを読む）
      items: z
        .object({
          data: z
            .array(
              z.object({
                price: z
                  .object({
                    // 価格に付けた名前（プランとの対応は BILLING_PRICE_LOOKUP_KEYS が持つ）
                    lookup_key: z.string().min(1).max(BILLING_WEBHOOK_FIELD_MAX_LENGTH).nullish(),
                  })
                  .nullish(),
              }),
            )
            .nullish(),
        })
        .nullish(),
    }),
  }),
});

/** 検証を通した受信イベントの型（`planChangeFor` が受け取る形） */
export type BillingWebhookEvent = z.infer<typeof billingWebhookEventSchema>;
