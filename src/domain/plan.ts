// 契約プラン (Plan) ごとの上限と機能の可否の**唯一の真実の源**。
//
// `src/domain/rbac.ts` の `PERMISSIONS` と同じ流儀で、**網羅的な表 1 つ**に全プランの値を置き、
// 判定はその表を読む純粋関数だけが行う（書き下すと「表と実装が食い違っても気付かない」形になる。
// Step4 の `RULE_COMPARISON` で実測した失敗と同じ）。
//
// **DB・Next.js に依存しない**ので、プランの差はユニットテストで全パターン固定できる（§11）。
import { Plan } from '@/domain/types';

/**
 * プランで**可否**が変わる機能の名前。
 *
 * 上限（数の大小）はここに入れず `PlanLimits` の数値で表す。可否に入れるのは「安い側では
 * まるごと使わせない」もので、追加するとその機能のルートに `requiredPlanFeature` の宣言が
 * 1 つ要る（宣言漏れは `tests/route-wrapping.test.ts` が印から導いて落とす）。
 */
export const PLAN_FEATURES = [
  // 監査ログの改ざん検証 (`GET /audit-logs/verify`)。1 回で最大 1 万行を読んで同数の HMAC を
  // 計算し直す最重量の読み取りなので、無料プランでは開けない（一覧の参照は許す）
  'auditChainVerify',
] as const;
/** 機能の名前の型（上の配列の要素型） */
export type PlanFeature = (typeof PLAN_FEATURES)[number];

/** 1 プランぶんの上限と可否。**プランを足すと型がキー不足で落ちる**ので埋め忘れが起きない */
export interface PlanLimits {
  /** 登録できるエージェントの数。超過は 409（上限の判定はアダプタが挿入と同じ操作の中で行う） */
  maxAgents: number;
  /** プロキシ経路の共有枠（1 分あたりの中継の回数） */
  proxyRateLimitPerMinute: number;
  /** 同時に有効にできるガードレールのルール数（行数の天井はこの値から導く） */
  maxEnabledGuardrailRules: number;
  /** 使える機能の集合（表に無い機能は使えない = fail-closed） */
  features: ReadonlySet<PlanFeature>;
}

/**
 * プランごとの上限と可否の表。**ここが正本**で、API・画面・レート制限はすべてこれを読む。
 *
 * **pro の値は Step4 までの固定値をそのまま引き継ぐ**（`proxyRateLimitPerMinute` = 600 は
 * ADR-0007 の実測「最悪の本文でも 1 通 3.3ms」から、`maxEnabledGuardrailRules` = 50 は
 * 「種別 3 × エージェント十数件 ＋ テナント全体のルール」から引いた値）。プラン別にしたことで
 * **既定が緩くなった利用者は 1 人もいない** — free は絞り、pro は据え置き、enterprise だけ広げる。
 */
export const PLAN_LIMITS: Readonly<Record<Plan, PlanLimits>> = {
  // 無料: 試用の規模。上流への課金が発生する中継は分あたりを絞り、重い読み取りは開けない
  [Plan.free]: {
    maxAgents: 3, // 試す目的なら 3 件（本番運用に足りない数にしてある）
    proxyRateLimitPerMinute: 60, // 毎秒 1 回ぶん。壊れたクライアントの暴走が課金に届かない高さ
    maxEnabledGuardrailRules: 5, // 種別 3 ＋ 予備 2。判定は中継 1 回ごとに走るので小さく保つ
    features: new Set<PlanFeature>(), // 可否で分けた機能はどれも使えない
  },
  // 標準の有料: Step4 までの固定値と同じ（既存の配備はこのプランに相当する）
  [Plan.pro]: {
    maxAgents: 25, // エージェント十数件という想定（ルール数の根拠と揃える）
    proxyRateLimitPerMinute: 600, // ADR-0007 の実測から引いた値（Step4 までの固定値）
    maxEnabledGuardrailRules: 50, // Step4 までの固定値
    features: new Set<PlanFeature>(['auditChainVerify']), // 改ざん検証を開ける
  },
  // 上位の有料: 規模の大きいテナント向けに各上限を引き上げる（機能の可否は pro と同じ）
  [Plan.enterprise]: {
    maxAgents: 200, // 一覧の既定ページ (PAGE_LIMIT_DEFAULT) を超える規模まで許す
    proxyRateLimitPerMinute: 3_000, // 毎秒 50 回ぶん。1 プロセスの処理能力の範囲に収める
    maxEnabledGuardrailRules: 200, // エージェント数に比例して増やす
    features: new Set<PlanFeature>(['auditChainVerify']), // pro と同じ
  },
};

/**
 * 表から読めないプランに当たったときに使うプラン。
 *
 * **ここが「どの次元でも最も厳しい」ことはテストが機械的に固定する**
 * （`tests/plan.test.ts`。プランを足したときにこの前提が崩れたら落ちる）。
 * 実行時に未知のプランが来るのは「DB の enum が増えたのにこの表を更新していない」場合だけで、
 * その食い違いは `Record<Plan, PlanLimits>` の型（キー不足）が先に落とす。
 */
export const FALLBACK_PLAN: Plan = Plan.free;

/**
 * プランの上限を引く純粋関数。
 *
 * **不明なら最も厳しい側へ倒す**（§9 の fail-closed）。throw にしない理由は、ここで落とすと
 * 「DB に enum 外の値が 1 行ある」だけで**そのテナントの全 API が 500** になるため — 機能を
 * 縮退して続ける方が §9 の求める倒れ方に合う。黙って倒れないよう、サーバログに 1 行残す。
 */
export function planLimitsFor(plan: Plan): PlanLimits {
  // 表に**自身のキーとして**存在するプランだけを信用する（素の添字だと `constructor` 等が
  // Object 由来の値を返し、上限の比較が TypeError になる。`canPerform` と同じ理由）
  if (!Object.hasOwn(PLAN_LIMITS, plan)) {
    // 値そのものはログに混ぜない（出してよい形は定型文だけ。src/lib/describe-error.ts の規約）
    console.error('[plan] 未知の契約プランを最も厳しいプランとして扱いました');
    // 最も厳しいプランの上限で続ける
    return PLAN_LIMITS[FALLBACK_PLAN];
  }
  // 表からそのプランの上限を返す
  return PLAN_LIMITS[plan];
}

/**
 * プランが機能を使えるかを判定する純粋関数。
 *
 * **未知のプランでも未知の機能でも false**（fail-closed）。`canPerform(role, action)` と同じ形に
 * してあるのは、API 層と画面が同じ述語を読むため（書き下すと「ボタンは出るのに 403」になる）。
 */
export function planAllows(plan: Plan, feature: PlanFeature): boolean {
  // 表に無いプランは何も使えない扱いにする（上限の方と違い、ここは拒否で縮退できる）
  if (!Object.hasOwn(PLAN_LIMITS, plan)) return false;
  // そのプランの機能の集合に含まれているかを返す
  return PLAN_LIMITS[plan].features.has(feature);
}

/**
 * ガードレールのルールの**行数**の天井を有効側の上限から導く係数。
 *
 * Step4 の `GUARDRAIL_RULE_ROWS_MAX_PER_TENANT` が有効側の 4 倍だったのを引き継ぐ
 * （無効化した行は有効側に数えないので、総行数を縛るものが別に要る。理由は ADR-0010）。
 */
export const GUARDRAIL_RULE_ROWS_FACTOR = 4;

/**
 * プランから「ガードレールのルール数の 2 つの上限」を組み立てる。
 *
 * **行数の天井を表に持たせず導出する**のは、2 つの値が独立に動くと「有効側より小さい天井」の
 * ような成立しない組み合わせを書けてしまうため（Port は両方を必須で受け取る）。
 */
export function guardrailRuleLimitsFor(plan: Plan): { maxEnabled: number; maxRows: number } {
  // そのプランの有効側の上限を引く
  const maxEnabled = planLimitsFor(plan).maxEnabledGuardrailRules;
  // 行数の天井は有効側の定数倍（Step4 と同じ係数）
  return { maxEnabled, maxRows: maxEnabled * GUARDRAIL_RULE_ROWS_FACTOR };
}
