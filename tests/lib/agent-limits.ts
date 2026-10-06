// テストがエージェントを作るときに渡す上限と、その結果を取り出す小さなヘルパー。
//
// **`repos.agents.create` は上限を必須で受け取る**（省略可にすると新しい呼び出し側が渡し忘れた
// ぶんだけ上限が静かに消える。Step4 の `GuardrailRuleLimits` と同じ判断）。そのぶん「上限そのものを
// 主題にしないテスト」が毎回値を書くことになるので、ここに 1 つ置いて共有する（§6 DRY）。
import type { AgentLimits, CreateAgentInput, CreateAgentResult, Repositories } from '@/data/ports';

/**
 * 上限の判定を主題にしないテストが渡す上限。
 *
 * **プランの表（`PLAN_LIMITS`）から引かない** — 引くとプランの値を変えたときにテストの意味が
 * 黙って変わる（「上限に当たらないつもりの seed」が当たるようになる）。十分に大きい固定値を置き、
 * 上限そのものを見るテストだけが小さい値を自分で渡す。
 */
export const TEST_AGENT_LIMITS: AgentLimits = { maxAgents: 1_000 };

/**
 * エージェントを 1 件作って行を返す（上限に当たったら失敗させる）。
 *
 * 戻り値が `{ status, agent }` の union なので、呼び出し側が毎回 `status` を見るのは冗長。
 * **「作れたはず」の確認をここに 1 か所置く**ことで、上限に当たったときは
 * `agent` が undefined のまま進んで分かりにくく落ちるのではなく、その場で理由が分かる。
 */
export async function createTestAgent(
  repos: Repositories,
  input: CreateAgentInput,
  limits: AgentLimits = TEST_AGENT_LIMITS,
) {
  // 作成を試みる
  const result: CreateAgentResult = await repos.agents.create(input, limits);
  // 上限に当たったらテストの前提が崩れているので、その場で止める
  if (result.status !== 'created') {
    throw new Error(`エージェントを作れません: ${result.status}`);
  }
  // 作れた行を返す
  return result.agent;
}
