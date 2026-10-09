// /api/v1/billing/webhook: 課金事業者（Stripe）からの受信 Webhook（Step6）。
//
// **`route()` を通らない唯一の API。** `route()` は必ず Bearer 認証を行うが、この経路を呼ぶのは
// 事業者であって利用者ではない。`RouteOptions` に `auth: 'none'` を足す形は採らなかった —
// 既定を 1 つ緩めると、どのルートも宣言 1 行で未認証にできる口になる（ADR-0012）。
// 代わりに `tests/route-wrapping.test.ts` の理由付きの表へ登録し、**署名検証を通ること**と
// **`no-store` を宣言すること**を機械で要求している（CSV の画面側ルートと同じ扱い）。
//
// 順序が決まっている: 鍵の確認（503）→ 本文を生テキストで読む（415 / 413）→ **署名検証（401）**
// → 解釈とスキーマ検証（400 / 422）→ 顧客 ID からテナントを引く → 反映すべきプランを決める
// → **受信記録とプランの反映を同じ原子的操作で行う（冪等性）** → 監査ログ → 200。
// **署名より前に解析しない**（未認証の相手に解析の費用を払わせず、400 / 422 と 401 の出方の
// 違いから受け付ける本文の形を探らせないため）。
//
// **受信記録を「反映より前の別の操作」にしてはいけない。** 記録だけが先に確定すると、反映に
// 失敗したイベントが「もう処理した」として扱われ、事業者の再送でもやり直せない（＝そのイベントは
// 永久に反映されない）。解約が落ちれば解約済みのテナントが有料の権限を保ち続ける。だから
// `recordOnce` へ反映を渡し、どちらかが失敗したら両方巻き戻す（ADR-0012）。
//
// **知らないイベントでも 200 を返す。** 事業者は契約と無関係な種別も送るので、エラーにすると
// 再送が延々と続き、本当に処理すべきイベントの配信が遅れる（§9 の「壊れたデータでクラッシュ
// させず、不正値はフォールバックする」）。
import { parseJsonText, readRawJsonText } from '@/lib/api/body';
import { ApiError } from '@/lib/api/errors';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { toErrorResponse } from '@/lib/api/handler';
import { withPrivateCacheHeaders } from '@/lib/api/cache-headers';
// 応答を数える唯一の入口 (route() を通らない経路もここを通す)
import { countHttpResponse } from '@/lib/metrics';
import { getRepos } from '@/data';
import type { BillingPlanApplication } from '@/data/ports';
import type { Plan } from '@/domain/types';
import { API_MESSAGES } from '@/lib/constants';
import { isPlanChangeEvent, isStaleCancellation, planChangeFor } from '@/lib/billing/events';
import { PLAN_CHANGE_SOURCE, recordPlanChangeAudit } from '@/lib/billing/apply-plan';
import { assertAuditConfigured } from '@/lib/audit/record';
import {
  BILLING_SIGNATURE_HEADER,
  billingWebhookSecret,
  verifyBillingSignature,
} from '@/lib/billing/signature';
import { billingWebhookEventSchema } from '@/lib/validations/billing';
import { logEvent } from '@/lib/log';

// 課金事業者の名前（受信記録のキーの一部。いまは stripe の 1 つだけ）
const PROVIDER = 'stripe';
// 1 秒のミリ秒数（署名の時刻は UNIX 秒なので直すのに使う）
const MILLIS_PER_SECOND = 1_000;

/** POST /billing/webhook (receiveBillingWebhook) */
export async function POST(request: Request): Promise<Response> {
  // 応答を組み立てる
  const response = await respond(request);
  // **この応答も 1 件数える**。未認証で誰でも叩ける経路なので、署名の不一致（401）が
  // 増えたことはここでしか分からない（鍵の設定ミスや総当たりが無言にならないようにする）
  countHttpResponse('POST', response.status);
  // 組み立てた応答をそのまま返す
  return response;
}

// 署名を確かめてプランへ反映する（応答を数えるのは上の 1 か所に寄せる）
async function respond(request: Request): Promise<Response> {
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
    // **反映する前に「監査ログを書ける状態か」を確かめる** — 反映してから記録に失敗すると、
    // 再送は「2 通目」として無視されるので**その変更が記録の無いまま残る**。鍵が無いなら
    // 1 行も書かず 503 を返し、事業者の再送でやり直させる（§9 fail-closed）
    assertAuditConfigured();
    // 顧客 ID からテナントを引く（引けなければ null。**記録は残す** — 残さないと
    // 「知らない顧客からの再送」を何度でも処理してしまう）
    const customerId = event.data.object.customer ?? null;
    const tenant =
      customerId === null ? null : await repos.tenants.findByBillingCustomerId(customerId);
    // 反映すべきプランを決める（知らない種別・知らない価格・未確定の状態なら null）
    const change = planChangeFor(event);
    // 反映に渡すもの（渡さなければ「受信の記録だけ」になる）と、記録に残す変更前のプラン
    let pending: { apply: BillingPlanApplication; from: Plan } | null = null;
    // 反映しない理由（ログに残すのは初めての受信のときだけなので、ここでは**種類だけ**を持つ）
    let skipped: SkipReason | null = null;
    if (tenant === null) {
      // 顧客 ID に対応するテナントが無い（連携していない・取り違えている）
      skipped = SKIP_REASON.tenantMissing;
    } else if (change === null) {
      // 種別は表にあるのにプランを決められなかった（価格の名前の取り違え・未確定の状態）
      skipped = SKIP_REASON.planUndecidable;
    } else if (isStaleCancellation(change, tenant.billingSubscriptionId)) {
      // **いまの契約とは別のサブスクリプションの解約は反映しない**（配信順は保証されないので、
      // 解約の再送が遅れているあいだに結び直した新しい契約を古い解約が打ち消しうる）
      skipped = SKIP_REASON.staleCancellation;
    } else {
      // 反映できる。**ID が本文に無いときは項目ごと渡さない** — Port の `null` は「未連携へ
      // 戻す」という明示の指示なので、無条件に渡すと**本文が ID を運んでいないだけの再送で
      // 既存の連携が消える**（`data.object.id` は省略されうる。`undefined` なら据え置き）
      pending = {
        apply: {
          tenantId: tenant.id,
          update: {
            plan: change.plan,
            ...(change.subscriptionId === null
              ? {}
              : { billingSubscriptionId: change.subscriptionId }),
          },
          // **解約のときだけ「いまの契約のままか」を条件にする** — 読んでから書くまでの間に
          // 結び直されていたら反映しない（契約の開始・変更は新しい契約が勝つので条件なし）
          expectSubscriptionId: change.cancellation ? tenant.billingSubscriptionId : null,
        },
        from: tenant.plan,
      };
    }
    // **受信の記録とプランの反映を 1 度だけ・同じ原子的操作で行う（冪等性）.** 判定は DB の
    // 一意制約に任せるので、同時に届いた 2 通でも必ず 1 通だけが `recorded` になる
    const recorded = await repos.billingEvents.recordOnce(
      { provider: PROVIDER, eventId: event.id, type: event.type, tenantId: tenant?.id ?? null },
      pending?.apply ?? null,
    );
    // 2 通目は何もせず 200（再送は正常系。エラーにすると事業者が再送を増やす）
    if (recorded.outcome === 'duplicate') return received(false);
    // **反映しなかった理由は「初めての受信」のときだけ残す** — 判定より前に出すと、同じ
    // イベントの再送（事業者の at-least-once・画面からの手動再送）のたびに同じ行が鳴り、
    // 「無関係な通知で鳴らさない」ために種別で絞った意味が薄れる
    if (skipped !== null) logSkipped(skipped, event.type);
    // 反映を渡していない（上の理由のどれか）か、条件に合わなかった／並行削除なら反映できていない
    if (pending === null || recorded.tenant === null) return received(false);
    // 監査ログに 1 行残す（記録の形は `PATCH /tenants/{tenantId}` と共有する）
    await recordPlanChangeAudit(repos, {
      tenantId: recorded.tenant.id,
      from: pending.from,
      // 変更後は**実際に書かれた行**から取る（渡した値ではなく保存された値）
      to: recorded.tenant.plan,
      update: pending.apply.update,
      source: PLAN_CHANGE_SOURCE.webhook,
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
 * 反映しなかった理由（ログの文はこの種類から選ぶ）。
 *
 * **文字列を組み立ててログへ渡さない** — ログは閉じた語彙（`src/lib/log.ts` の `LOG_EVENTS`）で
 * 名乗る形なので、理由ごとに**別の出来事**として出す（`tests/error-logging.test.ts` が
 * 第 1 引数が語彙のキーのリテラルであることを構文で見張る）。理由を値として持ち、
 * 出来事へ写すのは `logSkipped` の中だけに限る。
 */
const SKIP_REASON = {
  // 顧客 ID に対応するテナントが無い
  tenantMissing: 'tenant_missing',
  // 種別は表にあるのにプランを決められなかった
  planUndecidable: 'plan_undecidable',
  // いまの契約とは別のサブスクリプションの解約
  staleCancellation: 'stale_cancellation',
} as const;
/** 反映しなかった理由の型 */
type SkipReason = (typeof SKIP_REASON)[keyof typeof SKIP_REASON];

/**
 * 反映しなかったことをサーバログに残す。
 *
 * **契約の変更イベントのときだけ残す** — 事業者は契約と無関係な種別（`payout.paid` 等。
 * 顧客 ID を持たない）も送るので、種別を見ずに残すと**無関係な通知のたびに「設定が違う」と鳴り**、
 * 本当の取り違えが埋もれる。解約の取り違えは種別が必ず表にあるので同じ条件で足りる。
 */
function logSkipped(reason: SkipReason, type: string): void {
  // 無関係な通知では鳴らさない
  if (!isPlanChangeEvent(type)) return;
  // 理由ごとに固定の文を出す（値そのものは出さない）
  if (reason === SKIP_REASON.tenantMissing) {
    logEvent('billing.customer_unknown');
  } else if (reason === SKIP_REASON.planUndecidable) {
    logEvent('billing.plan_undecidable');
  } else {
    logEvent('billing.stale_cancellation');
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
