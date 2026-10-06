// 受信した課金イベントの Port (契約)。実装は adapters/memory と adapters/prisma。
//
// **この Port の役目は冪等性ひとつだけ。** 課金事業者の Webhook は再送されるのが前提なので、
// 同じイベントが 2 回以上届く。2 通目で「もう処理した」と答えられる仕組みが無いと、プランの
// 反映そのものは同じ結果でも**記録と監査ログが二重に増える**。

// 受信記録の入力
export interface RecordBillingEventInput {
  // 課金事業者の名前 (いまは stripe の 1 つだけ)
  provider: string;
  // 事業者側のイベント ID (Stripe なら evt_...)
  eventId: string;
  // イベント種別 (例: customer.subscription.updated)
  type: string;
  // 対応付けられたテナント (顧客 ID から引けなければ null)
  tenantId: string | null;
}

/**
 * 受信記録の結果。
 *
 * - `recorded`: この呼び出しが初めて記録した（＝呼び出し側は反映処理を進めてよい）
 * - `duplicate`: 既に同じイベントを記録済み（＝何もせず 200 を返す）
 *
 * **`duplicate` を例外（`DuplicateError` → 422）にしない。** 再送は正常系で、エラーとして
 * 返すと事業者側が「失敗した」と解釈してさらに再送し続ける（指数的に増える）。
 */
export type RecordBillingEventResult = 'recorded' | 'duplicate';

// 課金イベント Port
export interface BillingEventsPort {
  /**
   * イベントを 1 度だけ記録する。
   *
   * **判定は DB の一意制約に任せる。** 「処理済みか先に SELECT してから INSERT」の形にすると、
   * 同時に届いた 2 通がどちらも「未処理」を読んで両方が通る（Webhook は並行して届く）。
   * 一意制約の違反そのものを `duplicate` の判定に使うので、競合しても必ず 1 通だけが進む。
   */
  recordOnce(input: RecordBillingEventInput): Promise<RecordBillingEventResult>;
}
