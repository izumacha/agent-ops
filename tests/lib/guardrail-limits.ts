// テストがガードレールのルールを作るときに渡す上限。
//
// **`repos.guardrailRules.create` / `setEnabled` は上限を必須で受け取る**（省略可にすると
// 新しい呼び出し側が渡し忘れたぶんだけ上限が静かに消える）。そのぶん「上限そのものを主題に
// しないテスト」が毎回値を書くことになるので、ここに 1 つ置いて共有する（§6 DRY。
// エージェント数の上限で同じことをしている `tests/lib/agent-limits.ts` と同じ役目）。
import type { GuardrailRuleLimits } from '@/data/ports';

/**
 * 上限の判定を主題にしないテストが渡す上限。
 *
 * **プランの表（`PLAN_LIMITS`）から引かない** — 引くとプランの値を変えたときにテストの意味が
 * 黙って変わる（「上限に当たらないつもりの seed」が当たるようになる）。十分に大きい固定値を置き、
 * 上限そのものを見るテストだけが自分で値を渡す（API 経路の上限を見るテストは、ルートが
 * 読むのと同じ `guardrailRuleLimitsFor(seed のプラン)` から導く）。
 */
export const TEST_GUARDRAIL_RULE_LIMITS: GuardrailRuleLimits = {
  maxEnabled: 1_000,
  maxRows: 4_000,
};
