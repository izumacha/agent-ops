// 受信した課金イベントの Port を叩くテスト用の薄い包み（memory の対テストと契約テストが共有する）。
//
// **`recordOnce` の引数は省略可にしていない**（反映を渡し忘れた経路が静かに「記録だけ」へ戻るのを
// 防ぐため）。そのぶんテスト側で `null` を書き並べることになるので、意味のある既定を持つ包みを
// ここに 1 つだけ置く。**2 か所へ写さない** — Port の結果の形が次に変わったとき、片方だけが直って
// もう片方が古い読み方のまま残る（`tests/lib/agent-limits.ts` と同じ役割分担。§6 DRY）。
import type {
  BillingPlanApplication,
  RecordBillingEventInput,
  RecordBillingEventResult,
  Repositories,
  UpdateTenantPlanInput,
} from '@/data/ports';

/**
 * 反映を渡さずに受信だけを記録し、結果の種類だけを返す。
 *
 * **戻り値の型は Port の union をそのまま使う**（`string` へ広げない）— 広げると
 * `toBe('duplicat')` のような綴り違いがコンパイルを通り、実行時までずれに気付けない。
 */
export async function recordWithoutApply(
  repos: Repositories,
  input: RecordBillingEventInput,
): Promise<RecordBillingEventResult['outcome']> {
  // 反映なしで記録する
  const result = await repos.billingEvents.recordOnce(input, null);
  return result.outcome;
}

/**
 * 「条件なしで反映する」入力を組み立てる（契約 ID の突き合わせを要求しない場合）。
 *
 * 解約の競合を見るテストだけが `expectSubscriptionId` を自分で指定するので、それ以外は
 * ここを通して「条件なし」であることを 1 か所で表す。
 */
export function applyWithoutExpectation(
  tenantId: string,
  update: UpdateTenantPlanInput,
): BillingPlanApplication {
  // 条件なし（`null`）で反映する
  return { tenantId, update, expectSubscriptionId: null };
}
