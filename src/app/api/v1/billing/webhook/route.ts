// /api/v1/billing/webhook: 課金事業者（Stripe）からの受信 Webhook（Step6）。
//
// **`route()` を通らない唯一の API。** `route()` は必ず Bearer 認証を行うが、この経路を呼ぶのは
// 事業者であって利用者ではない。`RouteOptions` に `auth: 'none'` を足す形は採らなかった —
// 既定を 1 つ緩めると、どのルートも宣言 1 行で未認証にできる口になる（ADR-0012）。
// 代わりに `tests/route-wrapping.test.ts` の理由付きの表へ登録し、**署名検証を通ること**と
// **`no-store` を宣言すること**を機械で要求している（CSV の画面側ルートと同じ扱い）。
//
// 順序が決まっている: 鍵の確認（503）→ 本文を生テキストで読む（415 / 413）→ **署名検証（401）**
// → 解釈とスキーマ検証（400 / 422）→ 受信記録（冪等性）→ 顧客 ID からテナントを引く
// → 契約の状態と「いまの契約か」を確かめる → プランの反映 → 200。**署名より前に解析しない**（未認証の相手に解析の費用を払わせず、
// 400 / 422 と 401 の出方の違いから本文の形を探らせないため）。
//
// **知らないイベントでも 200 を返す。** 事業者は契約と無関係な種別も送るので、エラーにすると
// 再送が延々と続き、本当に処理すべきイベントの配信が遅れる（§9 の「壊れたデータでクラッシュ
// させず、不正値はフォールバックする」）。
import { parseJsonText, readRawJsonText } from '@/lib/api/body';
import { ApiError } from '@/lib/api/errors';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { toErrorResponse } from '@/lib/api/handler';
import { withPrivateCacheHeaders } from '@/lib/api/cache-headers';
import { getRepos } from '@/data';
import { API_MESSAGES } from '@/lib/constants';
import { isPlanChangeEvent, isStaleCancellation, planChangeFor } from '@/lib/billing/events';
import { applyPlanChange, PLAN_CHANGE_SOURCE } from '@/lib/billing/apply-plan';
import { assertAuditConfigured } from '@/lib/audit/record';
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
    // 共有シークレット（未設定・短すぎは 503。検証を飛ばして受け入れることはしない）。
    // **DB へ触る前に確かめる** — この経路は未認証なので、設定していない配備で
    // 誰でも接続プールを起こせる状態にしない
    const secret = billingWebhookSecret();
    // データ層の束（本番/テストの切り替えは Composition Root が持つ）
    const repos = await getRepos();
    // 本文を**生のテキストのまま**読む（415 → 413。署名の対象は受け取った本文そのまま）
    const raw = await readRawJsonText(request);
    // 署名を確かめる（**形が違う・時刻が古い・一致しない のどれでも同じ 401**。
    // 理由を区別して返すと総当たりの手がかりになる）。
    // **解釈より前に確かめる** — 後ろに置くと、未認証の相手に JSON の解析とスキーマ検証の費用を
    // 払わせたうえ、400 / 422 と 401 の出方の違いから受け付ける本文の形を探らせることになる
    const verified = verifyBillingSignature(
      request.headers.get(BILLING_SIGNATURE_HEADER),
      raw,
      secret,
      Math.floor(Date.now() / MILLIS_PER_SECOND),
    );
    if (verified !== 'ok') {
      throw new ApiError(HTTP_STATUS.UNAUTHORIZED, API_MESSAGES.billingSignatureInvalid);
    }
    // 署名が合ってから解釈・検証する（400 → 422）
    const event = parseJsonText(raw, billingWebhookEventSchema);
    // **受信を記録する前に「監査ログを書ける状態か」を確かめる** — 記録してから反映に失敗すると、
    // 再送は「2 通目」として無視されるので**そのイベントは永久に反映されない**。鍵が無いなら
    // 1 行も記録せず 503 を返し、事業者の再送でやり直させる（§9 fail-closed）
    assertAuditConfigured();
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
      // **契約の変更イベントのときだけログに残す** — 顧客 ID を引けないのは設定の取り違えだが、
      // 事業者は契約と無関係な種別（`payout.paid` 等。顧客 ID を持たない）も送るので、
      // 種別を見ずに残すと**無関係な通知のたびに「設定が違う」と鳴り**、本当の取り違えが埋もれる
      // （下の「価格を決められなかった」側と同じ分け方。値そのものは出さない）
      if (isPlanChangeEvent(event.type)) {
        console.error('[billing] 受信した顧客 ID に対応するテナントがありません');
      }
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
    // **いまの契約とは別のサブスクリプションの解約は反映しない**（配信順は保証されないので、
    // 解約の再送が遅れているあいだに結び直した新しい契約を古い解約が打ち消しうる）
    if (isStaleCancellation(change, tenant.billingSubscriptionId)) {
      // 取り落としたことは残す（値そのものは出さない）
      console.error('[billing] いまの契約とは別のサブスクリプションの解約なので反映しません');
      return received(false);
    }
    // プランと事業者側のサブスクリプション ID を同時に書き、監査ログに 1 行残す
    // （記録の形は `PATCH /tenants/{tenantId}` と共有する）。
    // **ID が本文に無いときは項目ごと渡さない** — Port の `null` は「未連携へ戻す」という
    // 明示の指示なので、無条件に渡すと**本文が ID を運んでいないだけの再送で既存の連携が消える**
    // （`data.object.id` は省略されうる。`undefined` なら据え置き）
    const applied = await applyPlanChange(repos, {
      tenantId: tenant.id,
      from: tenant.plan,
      update: {
        plan: change.plan,
        ...(change.subscriptionId === null ? {} : { billingSubscriptionId: change.subscriptionId }),
      },
      source: PLAN_CHANGE_SOURCE.webhook,
    });
    // 読んだ直後に消えた場合（並行削除）は反映できていない
    if (applied === null) return received(false);
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
