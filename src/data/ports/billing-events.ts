// 受信した課金イベントの Port (契約)。実装は adapters/memory と adapters/prisma。
//
// **この Port の役目は 2 つで、片方だけでは成り立たない。** 課金事業者の Webhook は再送されるのが
// 前提なので、(a) 同じイベントが 2 回以上届いても 1 回だけ効く必要がある。そして (b) その「1 回」は
// **プランの反映と同時に確定しなければならない** — 記録だけが先に通る形だと、反映に失敗した
// イベントが「もう処理した」として扱われ、再送が来ても何もしないまま 200 を返す
// (= そのイベントは永久に反映されない。解約が届かなければ解約済みのテナントが有料の権限を保つ)。
import type { TenantRecord } from './types';
import type { UpdateTenantPlanInput } from './tenants';

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
 * 受信と同じ原子的操作の中で反映するプラン変更。
 *
 * **「記録してから別の操作で反映する」形にしない。** 反映が失敗したときに巻き戻すのは記録の側で、
 * それを呼び出し側のコードで保証することはできない (途中でプロセスが落ちる・DB が切れる)。
 */
export interface BillingPlanApplication {
  // 反映先のテナント
  tenantId: string;
  // プランと課金事業者側の id (tenants Port と同じ入力の形)
  update: UpdateTenantPlanInput;
  /**
   * この契約 ID のままであることを条件に反映する (`null` = 条件なし)。
   *
   * **読んでから書くまでの間に契約が変わりうる。** 解約と結び直しは並行して届くので、
   * 「いまの契約か」を呼び出し側が**読んだ行**で判断すると、判断と書き込みの間に新しい契約が
   * 入った場合に古い解約がそれを打ち消す (= 課金が続いているテナントが free へ落ちる)。
   * 条件をアダプタへ渡し、**書き込みと同じ原子的操作の中で**突き合わせる。
   * 条件に合わなければ反映せず記録だけ残す (`tenant` は `null`)。
   */
  expectSubscriptionId: string | null;
}

/**
 * 受信記録の結果。
 *
 * - `outcome: 'recorded'` — この呼び出しが初めて記録した (＝呼び出し側は後続の記録を進めてよい)
 * - `outcome: 'duplicate'` — 既に同じイベントを記録済み (＝何もせず 200 を返す)
 * - `tenant` — 反映後のテナント行。反映を渡さなかったとき、および**対象が居なかったとき**は `null`
 *
 * **`duplicate` を例外 (`DuplicateError` → 422) にしない。** 再送は正常系で、エラーとして
 * 返すと事業者側が「失敗した」と解釈してさらに再送し続ける (指数的に増える)。
 */
export interface RecordBillingEventResult {
  // 初めて記録したか、2 通目か
  outcome: 'recorded' | 'duplicate';
  // 反映後のテナント (反映しなかった・対象が居なかったときは null)
  tenant: TenantRecord | null;
}

// 課金イベント Port
export interface BillingEventsPort {
  /**
   * イベントを 1 度だけ記録し、**同じ原子的操作の中で**プランを反映する。
   *
   * **判定は DB の一意制約に任せる。** 「処理済みか先に SELECT してから INSERT」の形にすると、
   * 同時に届いた 2 通がどちらも「未処理」を読んで両方が通る (Webhook は並行して届く)。
   * 一意制約の違反そのものを `duplicate` の判定に使うので、競合しても必ず 1 通だけが進む。
   *
   * **反映は省略可にしない** (`null` を明示して渡す)。既定で「反映しない」にすると、
   * 引数を足し忘れた経路が静かに「記録だけ」へ戻り、上のコメントが書いている穴が復活する
   * (`agents.create` の上限と同じ理由で、呼び出し側に必ず一度考えさせる)。
   *
   * 約束:
   * - `apply` が `null` のときは記録だけを行い、`tenant` は `null`
   * - `apply` の対象が居ない、または `expectSubscriptionId` が現在の行と合わなければ
   *   **記録だけ残して** `tenant` は `null`（再送しても結果は変わらないので、やり直させる意味が無い）
   * - 反映が失敗したら**記録も残らない** (例外が出る。事業者の再送でやり直せる)
   * - 2 通目なら**何も書かない** (`outcome: 'duplicate'`、`tenant` は `null`)
   *
   * **残る境界**: `input.tenantId` が指す行が**記録の瞬間に消えている**場合、prisma 側は外部キーの
   * 違反になる（翻訳しないので 500 → 事業者の再送でやり直す。次の試行では顧客 ID から引けず
   * `tenantId: null` で記録される）。memory 側は外部キーが無いので記録できてしまい、**ここだけ
   * 2 つのアダプタの答えが違う**（ADR-0006 の死角。実際の呼び出し側はテナントを引いた直後に
   * 呼ぶので窓は極めて狭く、翻訳を足すより「再送でやり直る」を選んでいる）。
   */
  recordOnce(
    input: RecordBillingEventInput,
    apply: BillingPlanApplication | null,
  ): Promise<RecordBillingEventResult>;
}
