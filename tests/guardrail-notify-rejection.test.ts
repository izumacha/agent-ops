// 「通知を待たない経路」で通知が**拒否**されたときの扱いを固定する。
//
// **なぜ別ファイルか**: ここだけ `@/lib/notify/send` をモジュールごと差し替える（`vi.mock` は
// ファイル単位で巻き上がるので、同じファイルの他の検査まで本物の通知を使えなくなる）。
//
// **なぜ要るか**: `void p` は値を捨てるだけで**拒否は処理しない**。`notifyGuardrailIncident` は
// 現在は例外を外へ出さない設計だが、1 か所 throw が増えるだけで（payload に `JSON.stringify`
// できない値が混ざる・鍵の形が壊れて `createHmac` が投げる 等）unhandled rejection になり、
// Node の既定（`--unhandled-rejections=throw`）では**中継 1 回でプロセスが落ちる**。
// 待たない経路を使うのは中継＝最も頻度の高い経路なので、ここは落としておく。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRepos, MemoryStore } from '@/data/adapters/memory';
import { Provider, RuleAction, RuleKind } from '@/domain/types';
import { USAGE_RULE_KINDS } from '@/lib/guardrail/evaluate';
// エージェントを作るテスト用ヘルパー (上限は必須引数なので 1 か所にまとめる)
import { createTestAgent } from './lib/agent-limits';
import { loggedEvents } from './lib/log-lines';

// 通知のモジュールを差し替える（**必ず拒否する**通知にする）
vi.mock('@/lib/notify/send', () => ({
  // 呼ばれたら拒否する（本物は例外を出さない設計だが、将来そうなった場合を模す）
  notifyGuardrailIncident: vi.fn(async () => {
    throw new Error('通知が拒否された');
  }),
}));

// 監査ログの鍵（下限を満たす固定値）
const SECRET = 'notify-rejection-test-audit-secret-01';

describe('待たない経路での通知の拒否', () => {
  // エラー出力を捕まえる（文言を確かめるため）
  let logged: unknown[][];

  beforeEach(() => {
    // 捕まえた引数
    logged = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
  });

  afterEach(() => {
    // 差し替えを戻す
    vi.restoreAllMocks();
  });

  it('unhandled rejection にせず、理由をログへ残す', async () => {
    // 表とリポジトリ
    const store = new MemoryStore();
    const repos = createMemoryRepos(store);
    // テナントと初期 admin
    const created = await repos.tenants.createWithAdmin({
      name: 'テナント',
      admin: { email: 'admin@example.com', name: '管理者' },
      token: {
        prefix: 'aop_u_test',
        tokenHash: 'hash',
        name: '初期',
        expiresAt: new Date('2099-01-01T00:00:00Z'),
      },
    });
    const tenantId = created.tenant.id;
    // 判定対象のエージェント
    const agent = await createTestAgent(repos, {
      tenantId,
      name: 'bot',
      description: null,
      provider: Provider.anthropic,
      model: 'claude-sonnet-4-6',
      budgetMicroUsd: null,
    });
    // 必ず発火するコストルール（通知だけ。停止は主題ではない）
    const rule = await repos.guardrailRules.create(
      {
        tenantId,
        agentId: agent.id,
        kind: RuleKind.cost,
        threshold: 1,
        windowMinutes: 60,
        action: RuleAction.notify,
      },
      { maxEnabled: 50, maxRows: 200 },
    );
    if (rule.status !== 'created') throw new Error('ルールを作れません');
    // しきい値を超える利用イベント
    await repos.usageEvents.record({
      tenantId,
      agentId: agent.id,
      provider: Provider.anthropic,
      model: 'claude-sonnet-4-6',
      inputTokens: 1,
      outputTokens: 1,
      costMicroUsd: 1_000n,
      latencyMs: 1,
      statusCode: 200,
    });
    // 本体は差し替えたモジュールを読む側なので、ここで動的に取り込む
    const { evaluateGuardrails } = await import('@/lib/guardrail/evaluate');
    // **待たない側**で判定する（中継の経路と同じ）
    const result = await evaluateGuardrails(
      repos,
      {
        tenantId,
        agentId: agent.id,
        kinds: USAGE_RULE_KINDS,
        now: new Date(),
        actorId: null,
        detachNotifications: true,
      },
      { NODE_ENV: 'test', AUDIT_HMAC_SECRET: SECRET } as NodeJS.ProcessEnv,
    );
    // 判定そのものは成功している（通知の失敗で結果を変えない）
    expect(result.fired).toHaveLength(1);
    // 拒否が処理されるまで数ティック待つ（`catch` が付いていなければ vitest が
    // unhandled rejection としてこのテストを落とす）
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 理由がログに残っている（握り潰していない）。**照合は `event` で行う** — 文言は推敲して
    // よいという分担なので、散文で照合すると文言を直すだけで CI が赤くなる
    expect(loggedEvents(logged), '通知の拒否がログに残っていない').toContain(
      'guardrail.notify_failed',
    );
  });
});
