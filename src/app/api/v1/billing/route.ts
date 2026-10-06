// /api/v1/billing: 現在の契約プランと、そのプランの上限の参照（view 権限）。UC-10 / Step6。
//
// **参照しか持たない。** Checkout セッションの作成（事業者へ外向きに出す経路）は入れていない
// （ADR-0012 の宿題）。プランを変えられるのは Stripe の Webhook と
// プラットフォーム管理者の `PATCH /tenants/{tenantId}` の 2 つだけ。
import { requireAction } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import type { ApiSchemas } from '@/lib/api-types';
import { PLAN_FEATURES, planAllows, planLimitsFor } from '@/domain/plan';
import { sharedRateLimitFor } from '@/lib/api/rate-limit';

/**
 * GET /billing (getBilling)
 *
 * **上限と可否をそのまま返す。** 409 や 403 を受けた利用者が「いまの上限はいくつか」を
 * 知る経路がないと、エラーの文言から数値を消した（プラン別なので書けない）意味が無くなる。
 */
export const GET = route(async ({ principal }) => {
  // view 権限（閲覧は 3 役割すべてに許される。課金の参照に admin を要求しない —
  // 上限を知りたいのは API を使う operator / viewer の側）
  const { plan } = requireAction(principal, 'view');
  // そのプランの上限（表が唯一の参照元）
  const limits = planLimitsFor(plan);
  // **中継の枠は「実際に効いている値」を返す** — 環境変数（`PROXY_RATE_LIMIT_ENV`）で上書き
  // できるので、表の値をそのまま返すと「広告している上限と断られる上限が違う」ことになる
  // （この API の存在理由は 429 / 409 / 403 を受けた側が実際の上限を知ることなので、
  //  判定に使っているのと同じ関数から引く）
  const proxyRateLimitPerMinute = sharedRateLimitFor(principal);
  // 応答（機能の可否は PLAN_FEATURES から導くので、機能を足したら自動で増える）
  const body: ApiSchemas['Billing'] = {
    plan,
    limits: {
      maxAgents: limits.maxAgents,
      proxyRateLimitPerMinute,
      maxEnabledGuardrailRules: limits.maxEnabledGuardrailRules,
    },
    // 機能ごとの可否（名前を書き並べず、宣言した機能の一覧から作る）
    features: Object.fromEntries(
      PLAN_FEATURES.map((feature) => [feature, planAllows(plan, feature)]),
    ) as ApiSchemas['Billing']['features'],
  };
  return Response.json(body);
});
