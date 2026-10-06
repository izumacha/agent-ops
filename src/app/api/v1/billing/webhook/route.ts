// /api/v1/billing/webhook: 課金事業者（Stripe）からの受信 Webhook（Step6）。
//
// **`route()` を通らない唯一の API。** `route()` は必ず Bearer 認証を行うが、この経路を呼ぶのは
// 事業者であって利用者ではない。`RouteOptions` に `auth: 'none'` を足す形は採らなかった —
// 既定を 1 つ緩めると、どのルートも宣言 1 行で未認証にできる口になる（ADR-0012）。
// 代わりに `tests/route-wrapping.test.ts` の理由付きの表へ登録し、**署名検証を通ること**と
// **`no-store` を宣言すること**を機械で要求している（CSV の画面側ルートと同じ扱い）。
//
// 順序が決まっている: 鍵の確認（503）→ 本文（生テキスト付き）→ **署名検証（401）**
// → 受信記録（冪等性）→ 顧客 ID からテナントを引く → プランの反映 → 200。
//
// **知らないイベントでも 200 を返す。** 事業者は契約と無関係な種別も送るので、エラーにすると
// 再送が延々と続き、本当に処理すべきイベントの配信が遅れる（§9 の「壊れたデータでクラッシュ
// させず、不正値はフォールバックする」）。
import { readJsonBodyWithRaw } from '@/lib/api/body';
import { ApiError } from '@/lib/api/errors';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { toErrorResponse } from '@/lib/api/handler';
import { withPrivateCacheHeaders } from '@/lib/api/cache-headers';
import { getRepos } from '@/data';
import { API_MESSAGES } from '@/lib/constants';
import { isPlanChangeEvent, planChangeFor } from '@/lib/billing/events';
import {
  BILLING_SIGNATURE_HEADER,
  billingWebhookSecret,
  verifyBillingSignature,
} from '@/lib/billing/signature';
import { billingWebhookEventSchema } from '@/lib/validations/billing';

// 課金事業者の名前（受信記録のキーの一部。いまは stripe の 1 つだけ）
const PROVIDER = 'stripe';
// 1 秒のミリ秒数（署名の時刻は UNIX 秒なので直すのに使う）
const MILLIS_PER_SECOND = 1_000;

/** POST /billing/webhook (receiveBillingWebhook) */
export async function POST(request: Request): Promise<Response> {
  // 例外はすべて HTTP 応答へ写す（`route()` を通らないので、この 1 か所で受ける）
  try {
    // データ層の束（本番/テストの切り替えは Composition Root が持つ）
    const repos = await getRepos();
    // 共有シークレット（未設定・短すぎは 503。検証を飛ばして受け入れることはしない）
    const secret = billingWebhookSecret();
    // 本文を読む（415 → 413 → 400 → 422。**生テキストも受け取る** — 署名の対象はそれ）
    const { raw, value: event } = await readJsonBodyWithRaw(request, billingWebhookEventSchema);
    // 署名を確かめる（**形が違う・時刻が古い・一致しない のどれでも同じ 401**。
    // 理由を区別して返すと総当たりの手がかりになる）
    const verified = verifyBillingSignature(
      request.headers.get(BILLING_SIGNATURE_HEADER),
      raw,
      secret,
      Math.floor(Date.now() / MILLIS_PER_SECOND),
    );
    if (verified !== 'ok') {
      throw new ApiError(HTTP_STATUS.UNAUTHORIZED, API_MESSAGES.billingSignatureInvalid);
    }
    // 顧客 ID からテナントを引く（引けなければ null。**記録は残す** — 残さないと
    // 「知らない顧客からの再送」を何度でも処理してしまう）
    const customerId = event.data.object.customer ?? null;
    const tenant =
      customerId === null ? null : await repos.tenants.findByBillingCustomerId(customerId);
    // **受信を 1 度だけ記録する（冪等性）.** 判定は DB の一意制約に任せるので、同時に届いた
    // 2 通でも必ず 1 通だけが `recorded` になる
    const recorded = await repos.billingEvents.recordOnce({
      provider: PROVIDER,
      eventId: event.id,
      type: event.type,
      tenantId: tenant?.id ?? null,
    });
    // 2 通目は何もせず 200（再送は正常系。エラーにすると事業者が再送を増やす）
    if (recorded === 'duplicate') {
      return received(false);
    }
    // 対応するテナントが無ければ反映できない（記録は済んでいるので 200 で返す）
    if (tenant === null) {
      // **ログに残す** — 顧客 ID を引けないのは設定の取り違えで、黙って捨てると気付けない
      // （値そのものは出さない。出してよい形は定型文だけ）
      console.error('[billing] 受信した顧客 ID に対応するテナントがありません');
      return received(false);
    }
    // 反映すべきプランを決める（知らない種別・知らない価格なら null）
    const change = planChangeFor(event);
    if (change === null) {
      // **種別が表にある（= 契約の変更のはず）のに決められなかったときだけログに残す** —
      // 価格の名前の取り違えで「払っているのに反映されない」状態になるため
      if (isPlanChangeEvent(event.type)) {
        console.error('[billing] 契約の変更イベントからプランを決められませんでした');
      }
      return received(false);
    }
    // プランと事業者側のサブスクリプション ID を同時に書く
    await repos.tenants.updatePlan(tenant.id, {
      plan: change.plan,
      billingSubscriptionId: change.subscriptionId,
    });
    // 反映した
    return received(true);
  } catch (error) {
    // 応答へ写す（**`route()` と同じ関数**。500 のログもそこが残す）。
    // 失敗の応答にも `no-store` を付ける（成功と同じ扱い）
    return withPrivateCacheHeaders(toErrorResponse(error));
  }
}

/**
 * 受信した旨の 200 応答（`applied` は反映したかどうか）。
 *
 * **`no-store` を必ず付ける**（`route()` が包む応答と同じ扱い。この経路は `route()` を
 * 通らないので、付け忘れるとここだけ共有キャッシュに載りうる）。
 */
function received(applied: boolean): Response {
  // 共通のヘッダを付けて返す
  return withPrivateCacheHeaders(Response.json({ received: true, applied }));
}
