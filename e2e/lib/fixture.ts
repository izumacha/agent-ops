// E2E と Lighthouse が使う仕込みデータ（Step5）。
//
// **専用 DB でしか走らない。** 全テーブルを TRUNCATE してから仕込むので、契約テストやベンチと
// 同じ「名前が `_contract` で終わる DB」の判定を通らなければ 1 行も書かずに落ちる（fail-closed）。
//
// **本番と同じ結線・同じ Port を通す**（`createPrismaClient` / `createPrismaRepos`）。SQL を直に
// 書いて仕込むと、画面が読む経路と仕込む経路が別物になり「テストだけ通る」形が生まれる。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { requireContractDatabase } from '../../scripts/lib/contract-database.mjs';
import { createPrismaRepos } from '../../src/data/adapters/prisma';
import { createPrismaClient } from '../../src/lib/prisma-client';
import { issueUserToken } from '../../src/lib/tokens';
import {
  GUARDRAIL_RULES_MAX_PER_TENANT,
  GUARDRAIL_RULE_ROWS_MAX_PER_TENANT,
} from '../../src/lib/constants';
import { Provider, RuleAction, RuleKind } from '../../src/domain/types';
// エージェントを作るテスト用ヘルパー (上限は必須引数なので 1 か所にまとめる)
import { createTestAgent } from '../../tests/lib/agent-limits';

// 仕込んだデータの受け渡し先。**ファイル経由にする**のは、Playwright の globalSetup と
// 各ワーカー・Lighthouse の計測が別プロセスで動くため（環境変数では渡らない）
const FIXTURE_PATH = join(process.cwd(), 'test-results', 'e2e-fixture.json');

// DB へ仕込んだ内容（画面を開くのに必要な最小限）
export interface E2eSeed {
  // ログイン画面に貼り付けるユーザートークン（平文。この仕込みでしか手に入らない）
  token: string;
  // エージェント詳細の URL を組み立てるための id
  agentId: string;
  // エージェントの表示名（一覧でその行を探すのに使う）
  agentName: string;
  // 未解決インシデントの id（解決の操作を確かめるのに使う）
  incidentId: string;
}

// 受け渡す内容。**起動したアプリの URL も入れる** — ポートは実行ごとに空きを取るので、
// テストのワーカーと Lighthouse が「いまどこで動いているか」を知る手段がこのファイルしかない
export interface E2eFixture extends E2eSeed {
  baseUrl: string;
}

// 仕込みに使う固定値（実在しないドメインのアドレスを使う。§15 スクショに実在のメールを写さない）
const TENANT_NAME = 'デモ商事';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_NAME = '運用管理者';
const TOKEN_NAME = 'ダッシュボード用';
// トークンの有効期間（日）。E2E の実行中に切れない十分な長さ
const TOKEN_TTL_DAYS = 30;
// 仕込むエージェント
const AGENT_NAME = '請求書読み取りエージェント';
const AGENT_MODEL = 'claude-sonnet-4-6';
// 仕込む利用イベント（ダッシュボードに数字が出るようにする）
const USAGE_EVENTS = [
  { inputTokens: 1_200, outputTokens: 800, costMicroUsd: 18_000n, statusCode: 200, latencyMs: 820 },
  { inputTokens: 900, outputTokens: 500, costMicroUsd: 11_500n, statusCode: 200, latencyMs: 640 },
  { inputTokens: 400, outputTokens: 0, costMicroUsd: 0n, statusCode: 502, latencyMs: 210 },
];
// 仕込むガードレールのルール（インシデントを作るのに 1 本必要）
const RULE_THRESHOLD_MICRO_USD = 20_000;
const RULE_WINDOW_MINUTES = 60;
// 仕込むインシデントの要約（本番と同じく機微情報を入れない 1 行）
const INCIDENT_SUMMARY =
  'コスト超過: 直近 60 分の料金 29500 マイクロ USD がしきい値 20000 を超えました';

/**
 * 専用 DB を空にしてから、画面を開くのに必要な行を仕込む。
 * 書き出しは呼び出し側が `writeE2eFixture` で行う（URL が決まるのはアプリを起動した後）。
 */
export async function seedE2eFixture(): Promise<E2eSeed> {
  // 開発 DB を指していれば 1 行も書かずに落ちる（ベンチ・契約テストと同じ判定を共有する）
  requireContractDatabase('e2e');
  // 本番と同じ結線でクライアントを作る
  const client = createPrismaClient();
  // 本番と同じアダプタ
  const repos = createPrismaRepos(client);
  try {
    // 全テーブルを空にする（値を埋め込まないタグ付きテンプレート）
    await client.$executeRaw`TRUNCATE TABLE "Tenant" CASCADE`;
    // ログイン用のトークンを発行する（平文はここでしか手に入らない）
    const issued = issueUserToken(TOKEN_NAME, TOKEN_TTL_DAYS);
    // テナント + admin + トークンを原子的に作る（本番の UC-01 と同じ経路）
    const created = await repos.tenants.createWithAdmin({
      name: TENANT_NAME,
      admin: { email: ADMIN_EMAIL, name: ADMIN_NAME },
      // 保存用の入力は発行の一式から取る（平文と別の文字列からハッシュを作る取り違えを防ぐ）
      token: issued.input,
    });
    // エージェントを 1 件作る
    const agent = await createTestAgent(repos, {
      tenantId: created.tenant.id,
      name: AGENT_NAME,
      description: '請求書 PDF を読み取って仕訳の候補を作るエージェント',
      provider: Provider.anthropic,
      model: AGENT_MODEL,
      budgetMicroUsd: 500_000n,
    });
    // 利用イベントを仕込む（ダッシュボードのコスト・稼働率・日次表が数字を持つようにする）
    for (const event of USAGE_EVENTS) {
      // 1 件ずつ本番と同じ Port 経由で記録する
      const recorded = await repos.usageEvents.record({
        tenantId: created.tenant.id,
        agentId: agent.id,
        provider: Provider.anthropic,
        model: AGENT_MODEL,
        ...event,
      });
      // 記録できなければ仕込みが壊れている（fail-closed）
      if (recorded === null) throw new Error('利用イベントを記録できません');
    }
    // コスト超過のルールを 1 本作る（通知だけ。E2E でエージェントを止めるのは画面の操作で行う）
    const rule = await repos.guardrailRules.create(
      {
        tenantId: created.tenant.id,
        agentId: agent.id,
        kind: RuleKind.cost,
        threshold: RULE_THRESHOLD_MICRO_USD,
        windowMinutes: RULE_WINDOW_MINUTES,
        action: RuleAction.notify,
      },
      { maxEnabled: GUARDRAIL_RULES_MAX_PER_TENANT, maxRows: GUARDRAIL_RULE_ROWS_MAX_PER_TENANT },
    );
    // 作れていなければ仕込みが壊れている
    if (rule.status !== 'created') throw new Error(`ルールを作れません: ${rule.status}`);
    // 未解決インシデントを 1 件作る（インシデント一覧に行が出るようにする）
    const raised = await repos.incidents.raise({
      tenantId: created.tenant.id,
      agentId: agent.id,
      ruleId: rule.rule.id,
      summary: INCIDENT_SUMMARY,
      // 停止はしない（停止・復帰はエージェント詳細の画面から操作する）
      suspendAgent: false,
    });
    // 作れていなければ仕込みが壊れている
    if (raised === null) throw new Error('インシデントを作れません');
    // 仕込んだ内容を返す（書き出しは URL が決まってから）
    return {
      token: issued.secret,
      agentId: agent.id,
      agentName: agent.name,
      incidentId: raised.incident.id,
    };
  } finally {
    // 接続を必ず閉じる（§8 リソースを確実に解放する）
    await client.$disconnect();
  }
}

/** 仕込んだ内容と URL を受け渡し用に書き出す（置き場が無ければ作る）。 */
export function writeE2eFixture(fixture: E2eFixture): void {
  // 置き場を用意する（test-results は gitignore 済み）
  mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
  // 人が読める形で書く（失敗を追うときに中身を見る）
  writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2));
}

/** 仕込んだ内容を読む（E2E のワーカーと Lighthouse が呼ぶ）。無ければ理由を付けて落ちる。 */
export function readE2eFixture(): E2eFixture {
  // 書き出したファイルを読む
  try {
    return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as E2eFixture;
  } catch (error) {
    // 仕込みを先に走らせていないことが大半なので、理由を付けて落とす（§6 握り潰さない）
    throw new Error(
      `仕込みデータを読めません (${FIXTURE_PATH}): 先に仕込みを実行してください` +
        ` / ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
