// Step4 の受け入れ基準「ルール発火から停止まで ≦ 3 秒」を実測するベンチ。
//   DATABASE_URL='postgresql://…/agent_ops_contract?schema=app' npm run bench:guardrail
// **開発 DB では走らない** — 全テーブルを TRUNCATE してから仕込むので、契約テストと同じ
// 「専用 DB の名前 (末尾 _contract)」の判定を通らなければ 1 件も書かずに落ちる (fail-closed)。
//
// **測るのは「超過した状態が揃ってから、停止が DB に書かれるまで」** = `evaluateGuardrails` の
// 1 回分。起点 (中継・評価実行・明示実行の API) はどれもこの関数を通るので、ここを測れば
// 起点によらない「発火 → 停止」の時間になる (HTTP の往復はこの基準の対象ではない)。
//
// **通知の環境変数は渡さない。** 通知先が未設定なら `notifyGuardrailIncident` は送らずに戻るので、
// 外部の受け手の応答時間が基準の 3 秒に混ざらない (`evaluateGuardrails` が通知を最後に回している
// 理由と同じ)。**実際の Webhook も Anthropic / OpenAI も呼ばない。**
import 'dotenv/config';
import { runBench } from './lib/bench-criteria.mjs';
import { requireContractDatabase } from './lib/contract-database.mjs';
import { GUARDRAIL_STOP_MAX_MS } from './lib/step4-criteria.mjs';
import { createPrismaRepos } from '../src/data/adapters/prisma';
import { createPrismaClient } from '../src/lib/prisma-client';
import { evaluateGuardrails } from '../src/lib/guardrail/evaluate';
import { generateSecret } from '../src/lib/tokens';
import { AgentStatus, Plan, Provider, RuleAction, RuleKind } from '../src/domain/types';
import { GUARDRAIL_RULES_MAX_PER_TENANT } from '../src/lib/constants';

// 仕込むルールの集計窓の長さ (分)。短すぎると投入した利用イベントが窓から外れる
const RULE_WINDOW_MINUTES = 60;
// 発火させるコストのしきい値 (マイクロ USD)。投入額がこれを必ず上回るようにする
const RULE_THRESHOLD_MICRO_USD = 1_000;
// 投入する 1 件あたりの料金を、しきい値の何倍にするか (超過を確実にするための倍率)
const SPEND_MULTIPLE_OF_THRESHOLD = 10;
// 仕込む利用イベントの件数。**1 件では窓の集計が 1 行しか見ない**ので、実運用に近い行数を入れる
const USAGE_EVENT_COUNT = 50;
// 判定を測る回数 (最初の 1 回は接続や計画のぶんが乗るので、最も遅い回で判定する)
const MEASURE_ROUNDS = 3;
// 投入するイベントのモデル名 (料金表とは独立。窓の集計は記録された料金を足すだけ)
const MODEL = 'claude-sonnet-4-6';
// 投入するイベントの応答ステータス (成功。エラー率ルールは仕込まないので 200 でよい)
const STATUS_CODE = 200;
// 監査ログを数えるときに読むページの上限。**ラウンド数を流用しない** — 1 ラウンドで書かれる
// 監査行が 2 件以上になった時点でページが黙って切り詰められ、門番が過少に数えて素通りする
const AUDIT_PAGE_LIMIT = 50;

// ベンチ本体。**判定も出力も終了コードもここには書かない** — 計測結果を返すだけにして、
// 受け入れ基準の強制は scripts/lib/bench-criteria.mjs の runBench に集約する (理由はそちら)
async function main(): Promise<Record<string, unknown>> {
  // 本番と同じ結線でクライアントを作る
  const client = createPrismaClient();
  // 本番と同じアダプタ (発火の記録と停止を 1 トランザクションで行うのもここ)
  const repos = createPrismaRepos(client);
  // **監査ログの鍵は使い捨てを作って判定へ渡す。** リポジトリに鍵を書かないのが要点で、
  // `generateSecret` は本番のトークン発行と同じ乱数源なので最小長も満たす。
  // `process.env` を書き換えず、`evaluateGuardrails` の env 引数へ渡す (環境を汚さない)
  // (`NODE_ENV` は `ProcessEnv` の必須項目なので実行中の値をそのまま引き継ぐ)
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV,
    AUDIT_HMAC_SECRET: generateSecret('apiKey'),
  };
  // 投入する 1 件あたりの料金 (マイクロ USD)。**main の中で導く** — トップレベルの初期化子で
  // 計算すると、専用 DB のガードより前に走る式が増える (ベンチの静的検査が許す形に合わせる)
  const spentMicroUsd = BigInt(RULE_THRESHOLD_MICRO_USD * SPEND_MULTIPLE_OF_THRESHOLD);
  // 後始末のために try で囲む
  try {
    // 全テーブルを空にする (値を埋め込まないタグ付きテンプレート)
    await client.$executeRaw`TRUNCATE TABLE "Tenant" CASCADE`;
    // 各回の所要時間
    const durations: number[] = [];
    // 発火したルールの総数 (判定が実際に動いたことの証拠)
    let firedRules = 0;
    // 停止が永続化された回数
    let suspendedAgents = 0;
    // 書かれた監査ログの件数
    let auditRows = 0;
    // 複数回測る。**毎回まるごと仕込み直す** — 1 度停止したエージェントは 2 回目に
    // 「既に suspended」で状態が変わらず、停止の書き込みを含まない速い数字になる
    for (let round = 0; round < MEASURE_ROUNDS; round += 1) {
      // 前の回の仕込みを消す (テナントごと消せば子テーブルも Cascade で消える)
      await client.$executeRaw`TRUNCATE TABLE "Tenant" CASCADE`;
      // 計測用のテナント
      const tenant = await client.tenant.create({ data: { name: 'ベンチ', plan: Plan.free } });
      // 計測用のエージェント (active から始める)
      const agent = await client.agent.create({
        data: {
          tenantId: tenant.id,
          name: 'ベンチ用',
          provider: Provider.anthropic,
          model: MODEL,
          status: AgentStatus.active,
        },
      });
      // コスト超過で**停止する**ルールを 1 件作る (notify では状態が変わらず基準を測れない)
      const rule = await repos.guardrailRules.create(
        {
          tenantId: tenant.id,
          agentId: agent.id,
          kind: RuleKind.cost,
          threshold: RULE_THRESHOLD_MICRO_USD,
          windowMinutes: RULE_WINDOW_MINUTES,
          action: RuleAction.stop,
        },
        GUARDRAIL_RULES_MAX_PER_TENANT,
      );
      // 作れていなければ仕込みが壊れている (fail-closed。判定より前に落とす)
      if (rule.status !== 'created') throw new Error(`ルールを作れません: ${rule.status}`);
      // しきい値を超える利用イベントを仕込む (1 件ずつ本番と同じ Port 経由で記録する)
      for (let index = 0; index < USAGE_EVENT_COUNT; index += 1) {
        // 1 件分を記録する (料金だけが判定に効く)
        const recorded = await repos.usageEvents.record({
          tenantId: tenant.id,
          agentId: agent.id,
          provider: Provider.anthropic,
          model: MODEL,
          inputTokens: 100,
          outputTokens: 200,
          costMicroUsd: spentMicroUsd,
          latencyMs: 10,
          statusCode: STATUS_CODE,
        });
        // 記録できなければ仕込みが壊れている
        if (recorded === null) throw new Error('利用イベントを記録できません');
      }
      // **ここから計測**: 超過した状態が揃った時点から、停止が書かれるまで
      const startedAt = performance.now();
      // 判定の 1 回分 (ルールを引く → 窓を集計 → インシデント記録と停止 → 監査ログ → 通知)
      const evaluation = await evaluateGuardrails(
        repos,
        {
          tenantId: tenant.id,
          agentId: agent.id,
          // 中継の直後と同じ種別だけを見る (本番でコスト超過が発火する経路に合わせる)
          kinds: [RuleKind.cost],
          now: new Date(),
          // 自動発火なので操作主体は無し
          actorId: null,
        },
        env,
      );
      // この回の所要時間
      durations.push(Math.round(performance.now() - startedAt));
      // 発火した件数を足す
      firedRules += evaluation.fired.length;
      // **状態を読み直して**停止が永続化されたかを見る (戻り値の self-report だけを信じない)
      const stored = await repos.agents.findById(tenant.id, agent.id);
      // suspended になっていれば 1 回分として数える
      if (stored?.status === AgentStatus.suspended) suspendedAgents += 1;
      // 監査ログが残ったかを見る (鍵が無ければ記録は飛ばされるので、件数で確かめる)
      const logs = await repos.auditLogs.list(tenant.id, { limit: AUDIT_PAGE_LIMIT });
      // 残っていた件数を足す
      auditRows += logs.items.length;
    }
    // 判定には最も遅い回を使う (たまたま速かった回で通さない)
    const elapsedMs = Math.max(...durations);
    // 計測結果を返す (受け入れ基準は runBench が各項目を読んで掛ける)
    return {
      rounds: MEASURE_ROUNDS,
      usageEvents: USAGE_EVENT_COUNT,
      windowMinutes: RULE_WINDOW_MINUTES,
      durationsMs: durations,
      firedRules,
      suspendedAgents,
      auditRows,
      elapsedMs,
      limitMs: GUARDRAIL_STOP_MAX_MS,
    };
  } finally {
    // 接続を閉じる (§8 リソースを確実に解放する)
    await client.$disconnect();
  }
}

// **接続先が専用 DB かをここで確かめる** (開発 DB を TRUNCATE しない)。
// トップレベルの式文として呼ぶ理由は他のベンチと同じ (条件で囲める形にしない)
requireContractDatabase('bench:guardrail');

// 計測 → 判定 → 出力 → 終了コードを共有モジュールに任せて実行する
runBench('guardrail-stop', main);
