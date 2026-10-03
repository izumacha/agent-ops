// ガードレールのルール・インシデント・監査ログの契約テスト (実 PostgreSQL)。
// **memory アダプタでは見えないもの**をここで固定する:
//   - 追記専用トリガが監査ログの UPDATE / DELETE を拒否すること (Step4 の受け入れ基準「改ざん検知」)
//   - **トリガを外して書き換えたとき、連鎖の検証がそれを検知すること**
//     (トリガだけを見ていると「改ざんできないので検知も試せない」で終わり、検出網の中心が空洞になる)
//   - CHECK 制約が範囲外のしきい値・集計窓を拒否すること
//   - 複合 FK (tenantId, agentId) / (tenantId, ruleId) が他テナントの資源を指す行を拒否すること
//   - インシデントを持つルールが Restrict で守られること
//   - 発火の記録とエージェントの停止が 1 つのトランザクションで起きること
//   - 連番の採番が同じテナントで重複しないこと
// RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で全テーブルを TRUNCATE するため開発 DB を指さない
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GuardrailRuleRecord, Repositories } from '@/data/ports';
import {
  auditRowHash,
  verifyAuditChain,
  type AuditPayload,
  type StoredAuditRow,
} from '@/domain/audit/chain';
import { AgentStatus, IncidentStatus, Provider, RuleAction, RuleKind } from '@/domain/types';
import { secretsEqual, userTokenExpiresAt } from '@/lib/tokens';
import { runContractDatabaseGuard } from '../../scripts/lib/contract-database.mjs';

// 明示フラグが無ければ丸ごとスキップする
const ENABLED = process.env.RUN_PRISMA_CONTRACT === '1';

// テストで発行するトークンの有効期間 (日)
const TOKEN_TTL_DAYS = 1;
// エージェントが使うモデル名
const MODEL = 'claude-sonnet-4-6';
// ルール数の上限 (この検査では上限そのものは主題でないので十分大きい値を渡す)
const RULES_MAX = 50;
// 行数 (無効化したものを含む) の上限。有効なルールの上限だけでは総行数が縛れないので 2 つ渡す
const ROWS_MAX = 200;
// ほとんどのテストが使う上限の組 (件数の判定そのものを見るテストだけが別の値を渡す)
const LIMITS = { maxEnabled: RULES_MAX, maxRows: ROWS_MAX };
// 監査ログのハッシュ計算に使う鍵 (検査用の固定値)
const SECRET = 'contract-test-audit-secret-0123456789';
// 連鎖を読むときの上限
const CHAIN_LIMIT = 1_000;
// 監査ログに入れる payload。**キーを辞書順でない並びにし、型も混ぜる**。
// 正規化がキーを並べ替えなくなると、JSONB はキーの順序を保存しないので保存して読み直した
// ハッシュが**不定に**揺れる。単一キー・文字列だけの payload では、実 DB を通してもその退行が
// 一度も踏まれない (読み書きの順序が偶然一致するため)。`a|b` のキーは、正規化を区切り文字の
// 連結へ戻したときに隣の項目と境界がずれる形をここでも踏ませるために置いている
const AUDIT_PAYLOAD: AuditPayload = {
  threshold: 1_000,
  kind: 'cost',
  observed: 1234.5,
  suspended: true,
  note: null,
  'a|b': 'c',
};
// ロックの存在を確かめるときの待ち時間 (これだけ待っても終わらなければ「待たされている」)
const LOCK_TEST_WAIT_MS = 500;
// ロックを掴んだままにするトランザクションの上限 (既定の 5 秒だと待ちの間に時間切れになる)
const LOCK_TEST_TRANSACTION_TIMEOUT_MS = 10_000;

// テナント + エージェントを 1 組作る
async function makeTenantWithAgent(repos: Repositories, label: string) {
  // テナントと初期 admin
  const created = await repos.tenants.createWithAdmin({
    name: `テナント${label}`,
    admin: { email: `admin-${label}@example.com`, name: `管理者${label}` },
    token: {
      prefix: 'aop_u_test',
      tokenHash: `hash-${label}-${Date.now()}-${Math.random()}`,
      name: '初期',
      expiresAt: userTokenExpiresAt(TOKEN_TTL_DAYS),
    },
  });
  // そのテナントのエージェント
  const agent = await repos.agents.create({
    tenantId: created.tenant.id,
    name: `bot-${label}`,
    description: null,
    provider: Provider.anthropic,
    model: MODEL,
    budgetMicroUsd: null,
  });
  // まとめて返す
  return { tenantId: created.tenant.id, agent, adminId: created.admin.id };
}

describe.skipIf(!ENABLED)('ガードレールと監査ログの契約', () => {
  // 実 DB のクライアントとリポジトリ (本番と同じ Composition Root 経由)
  let client: typeof import('@/lib/prisma').prisma;
  let repos: Repositories;

  // 接続する (生成物へ依存するモジュールはここで初めて読む)
  beforeAll(async () => {
    // 接続先が専用 DB であること (TRUNCATE する前に確かめる)
    runContractDatabaseGuard();
    const [{ prisma }, { getRepos }] = await Promise.all([
      import('@/lib/prisma'),
      import('@/data'),
    ]);
    client = prisma;
    repos = await getRepos();
  });

  // 全テーブルを空にする。**行トリガは TRUNCATE で発火しない**ので、追記専用の監査ログも消せる
  beforeEach(async () => {
    await client.$executeRaw`TRUNCATE TABLE "Tenant" CASCADE`;
  });

  // 監査ログを 1 行追記する (ハッシュはこのファイルの鍵で計算する)
  // 切り替えを行い、成功していることを確かめて「切り替えた後の有効・無効」を返す
  // (失敗の種類は呼び出し側が status で見る。ここは成功を前提にする経路の短縮)
  async function enabledAfter(tenantId: string, ruleId: string, enabled: boolean) {
    // 切り替える
    const result = await repos.guardrailRules.setEnabled(tenantId, ruleId, enabled, RULES_MAX);
    // 失敗していればテストとして落とす
    if (result.status !== 'ok') throw new Error(`切り替えに失敗しました: ${result.status}`);
    // 切り替えた後の値
    return result.rule.enabled;
  }

  async function appendAudit(tenantId: string, action: string, actorId: string | null = null) {
    // 記録日時はアプリ側が決める (DB の既定値に任せるとハッシュに入れた時刻とずれる)
    const createdAt = new Date();
    // 追記する (連番と prevHash はアダプタが採ってハッシュ計算へ渡す)
    return repos.auditLogs.append(
      {
        tenantId,
        actorId,
        action,
        targetType: 'Agent',
        targetId: 'ag-dummy',
        payload: AUDIT_PAYLOAD,
        createdAt,
      },
      // ドメインのハッシュ計算をそのまま使う (本番と同じ関数)
      ({ seq, prevHash, id }) =>
        auditRowHash(SECRET, {
          id,
          tenantId,
          seq,
          actorId,
          action,
          targetType: 'Agent',
          targetId: 'ag-dummy',
          payload: AUDIT_PAYLOAD,
          createdAt,
          prevHash,
        }),
    );
  }

  // 連鎖を読んで検証する
  async function verify(tenantId: string) {
    // 保存されている行を seq 昇順で読む
    const { rows } = await repos.auditLogs.readChain(tenantId, CHAIN_LIMIT);
    // ドメインの検証に掛ける (行の形はそのまま渡せる)
    return verifyAuditChain(SECRET, tenantId, rows as StoredAuditRow[], secretsEqual);
  }

  it('ルールは作成・一覧・削除できる', async () => {
    // テナントとエージェント
    const a = await makeTenantWithAgent(repos, 'a');
    // ルールを作る
    const created = await repos.guardrailRules.create(
      {
        tenantId: a.tenantId,
        agentId: a.agent.id,
        kind: RuleKind.cost,
        threshold: 1_000,
        windowMinutes: 60,
        action: RuleAction.stop,
      },
      LIMITS,
    );
    // 作成できている
    expect(created.status).toBe('created');
    // 一覧に出る
    const listed = await repos.guardrailRules.list(a.tenantId, { limit: 10 });
    expect(listed.items).toHaveLength(1);
    // 消せる (インシデントが無いので Restrict に当たらない)
    expect(created.status === 'created' && created.rule.id).toBeTruthy();
    if (created.status !== 'created') return;
    expect(await repos.guardrailRules.delete(a.tenantId, created.rule.id)).toBe('deleted');
  });

  it('他テナントのエージェントを指すルールは作れない (複合 FK)', async () => {
    // 2 つのテナント
    const a = await makeTenantWithAgent(repos, 'a');
    const b = await makeTenantWithAgent(repos, 'b');
    // テナント a のルールがテナント b のエージェントを指そうとする
    const result = await repos.guardrailRules.create(
      {
        tenantId: a.tenantId,
        agentId: b.agent.id,
        kind: RuleKind.cost,
        threshold: 1_000,
        windowMinutes: 60,
        action: RuleAction.stop,
      },
      LIMITS,
    );
    // 複合 FK (tenantId, agentId) が拒否する
    expect(result.status).toBe('agent_not_found');
  });

  it('上限に達していて、かつエージェント id も誤っているときはエージェント優先で答える', async () => {
    // **memory アダプタと答えを揃えるための検査** (ADR-0006 の構造的な死角)。
    // 挿入時の FK 違反だけでエージェントの不在を知る形だと、件数の判定が先に返るので
    // prisma は too_many_rules・memory は agent_not_found を返し、答えが割れる。
    // API テストは memory で走るため、割れたままだと本番だけ別のステータスになる
    const a = await makeTenantWithAgent(repos, 'a');
    // 上限 1 件としてまず 1 件作って上限まで埋める
    const filled = await repos.guardrailRules.create(
      {
        tenantId: a.tenantId,
        agentId: null,
        kind: RuleKind.cost,
        threshold: 1_000,
        windowMinutes: 60,
        action: RuleAction.notify,
      },
      { maxEnabled: 1, maxRows: ROWS_MAX },
    );
    expect(filled.status).toBe('created');
    // 上限に達した状態で、存在しないエージェントを指して作ろうとする
    const result = await repos.guardrailRules.create(
      {
        tenantId: a.tenantId,
        agentId: 'ag-does-not-exist',
        kind: RuleKind.quality,
        threshold: 0.7,
        windowMinutes: 60,
        action: RuleAction.notify,
      },
      { maxEnabled: 1, maxRows: ROWS_MAX },
    );
    // エージェントの不在を先に答える (そちらの方が利用者にとって直せる情報)
    expect(result.status).toBe('agent_not_found');
  });

  it('連鎖の読み出しは上限に達したことを伝える', async () => {
    // **上限の判定は 1 件多く取って比べる形**なので、take を上限ちょうどに戻すと
    // reachedLimit が永久に false になる。そうなると検証の API は、実際には
    // AUDIT_CHAIN_VERIFY_MAX_ROWS で切り詰められた連鎖に対して「全部確かめて無傷」と答える
    const a = await makeTenantWithAgent(repos, 'a');
    // 3 行追記する
    await appendAudit(a.tenantId, 'a1');
    await appendAudit(a.tenantId, 'a2');
    await appendAudit(a.tenantId, 'a3');
    // 上限 2 件で読むと 2 件だけ返り、続きがあることが分かる
    const limited = await repos.auditLogs.readChain(a.tenantId, 2);
    expect(limited.rows).toHaveLength(2);
    expect(limited.reachedLimit).toBe(true);
    // 上限に届かない読み出しでは false (件数は 3 件)
    const all = await repos.auditLogs.readChain(a.tenantId, CHAIN_LIMIT);
    expect(all.rows).toHaveLength(3);
    expect(all.reachedLimit).toBe(false);
    // **続きは fromSeq で読める。** これが無いと、行数が上限を超えたテナントでは毎回同じ
    // 最古の区間だけを検証し続け、それ以降の行は二度と検証されない (書き換えても「無傷」になる)
    const second = all.rows[1]!;
    const rest = await repos.auditLogs.readChain(a.tenantId, CHAIN_LIMIT, second.seq + 1n);
    expect(rest.rows.map((row) => row.seq)).toEqual([all.rows[2]!.seq]);
    // 錨は 1 つ前の行 (= 2 件目) のハッシュ。区間の継ぎ目を検証するのに使う
    expect(rest.anchorHash).toBe(second.hash);
    // 先頭から読むときは錨が無い
    expect(all.anchorHash).toBeNull();
  });

  it('存在しないテナントには作れない (memory 側と同じ答え)', async () => {
    // **エージェント指定が無い形**での答えを揃える（memory 側にも同じ検査がある）
    const created = await repos.guardrailRules.create(
      {
        tenantId: 'tenant_does_not_exist',
        agentId: null,
        kind: RuleKind.cost,
        threshold: 1,
        windowMinutes: 60,
        action: RuleAction.notify,
      },
      LIMITS,
    );
    expect(created.status).toBe('agent_not_found');
  });

  it('ルール数が上限に達したら作れない (判定と挿入が同じトランザクション)', async () => {
    // テナントとエージェント
    const a = await makeTenantWithAgent(repos, 'a');
    // 上限 1 件として 1 件作る
    const first = await repos.guardrailRules.create(
      {
        tenantId: a.tenantId,
        agentId: null,
        kind: RuleKind.cost,
        threshold: 1_000,
        windowMinutes: 60,
        action: RuleAction.notify,
      },
      { maxEnabled: 1, maxRows: ROWS_MAX },
    );
    expect(first.status).toBe('created');
    // 2 件目は上限に達しているので作れない
    const second = await repos.guardrailRules.create(
      {
        tenantId: a.tenantId,
        agentId: null,
        kind: RuleKind.quality,
        threshold: 0.7,
        windowMinutes: 60,
        action: RuleAction.notify,
      },
      { maxEnabled: 1, maxRows: ROWS_MAX },
    );
    expect(second.status).toBe('too_many_rules');
  });

  it('無効化したルールは上限に数えず、切り替えはテナント内に閉じる (memory 側と同じ答え)', async () => {
    // テナント 2 つ
    const a = await makeTenantWithAgent(repos, 'a');
    const b = await makeTenantWithAgent(repos, 'b');
    // 上限 1 件として 1 件作る
    const first = await repos.guardrailRules.create(
      {
        tenantId: a.tenantId,
        agentId: a.agent.id,
        kind: RuleKind.cost,
        threshold: 1_000,
        windowMinutes: 60,
        action: RuleAction.notify,
      },
      { maxEnabled: 1, maxRows: ROWS_MAX },
    );
    expect(first.status).toBe('created');
    if (first.status !== 'created') return;
    // **他テナントからは切り替えられない** (複合主キーの tenantId を落とすとクロステナントの書き込み)
    expect(
      await repos.guardrailRules.setEnabled(b.tenantId, first.rule.id, false, RULES_MAX),
    ).toMatchObject({ status: 'not_found' });
    // 存在しない id も「無い」(404 で隠すためにアダプタ側で区別しない)
    expect(
      await repos.guardrailRules.setEnabled(a.tenantId, 'gr_does_not_exist', false, RULES_MAX),
    ).toMatchObject({ status: 'not_found' });
    // 自テナントからは外せる
    expect(await enabledAfter(a.tenantId, first.rule.id, false)).toBe(false);
    // **上限 1 件でも次の 1 件が作れる** — 件数を数えるのは有効なルールだけだから
    // (無効化した行も数えると、発火して消せなくなったテナントはルールを増やせなくなる)
    const second = await repos.guardrailRules.create(
      {
        tenantId: a.tenantId,
        agentId: null,
        kind: RuleKind.quality,
        threshold: 0.7,
        windowMinutes: 60,
        action: RuleAction.notify,
      },
      { maxEnabled: 1, maxRows: ROWS_MAX },
    );
    expect(second.status).toBe('created');
    // 同じ値を 2 度送っても成功し (冪等)、戻せる
    expect(await enabledAfter(a.tenantId, first.rule.id, false)).toBe(false);
    expect(await enabledAfter(a.tenantId, first.rule.id, true)).toBe(true);
  });

  it('有効へ戻すときも上限を数え直す (memory と同じ答え)', async () => {
    // テナントと、ルール 2 件
    const a = await makeTenantWithAgent(repos, 'a');
    const made: GuardrailRuleRecord[] = [];
    for (const kind of [RuleKind.cost, RuleKind.quality]) {
      const created = await repos.guardrailRules.create(
        {
          tenantId: a.tenantId,
          agentId: null,
          kind,
          threshold: kind === RuleKind.cost ? 1_000 : 0.7,
          windowMinutes: 60,
          action: RuleAction.notify,
        },
        LIMITS,
      );
      expect(created.status).toBe('created');
      if (created.status !== 'created') return;
      made.push(created.rule);
    }
    // 1 件目を無効化する
    expect(await enabledAfter(a.tenantId, made[0].id, false)).toBe(false);
    // 上限 1 件の状態で戻そうとすると、有効な 1 件 (2 件目) がもう枠を埋めている
    expect(await repos.guardrailRules.setEnabled(a.tenantId, made[0].id, true, 1)).toMatchObject({
      status: 'too_many_rules',
    });
    // **断ったので行は無効のまま** (実 DB でもトランザクションが巻き戻る)
    const listed = await repos.guardrailRules.list(a.tenantId, { limit: 10 });
    expect(listed.items.find((row) => row.id === made[0].id)?.enabled).toBe(false);
    // 既に有効な行を有効へ送り直すのは数に入っているので通る (冪等)
    expect(await repos.guardrailRules.setEnabled(a.tenantId, made[1].id, true, 1)).toMatchObject({
      status: 'ok',
    });
  });

  it('行数の上限に達したら作れない (無効化した行も数える天井。memory と同じ答え)', async () => {
    // テナントとエージェント
    const a = await makeTenantWithAgent(repos, 'a');
    // 1 件作って無効化する (有効なルールは 0 件になる)
    const first = await repos.guardrailRules.create(
      {
        tenantId: a.tenantId,
        agentId: a.agent.id,
        kind: RuleKind.cost,
        threshold: 1_000,
        windowMinutes: 60,
        action: RuleAction.notify,
      },
      LIMITS,
    );
    expect(first.status).toBe('created');
    if (first.status !== 'created') return;
    await repos.guardrailRules.setEnabled(a.tenantId, first.rule.id, false, RULES_MAX);
    // 行数の天井 1 件に達しているので、有効側に余裕があっても作れない
    const second = await repos.guardrailRules.create(
      {
        tenantId: a.tenantId,
        agentId: null,
        kind: RuleKind.quality,
        threshold: 0.7,
        windowMinutes: 60,
        action: RuleAction.notify,
      },
      { maxEnabled: RULES_MAX, maxRows: 1 },
    );
    expect(second.status).toBe('too_many_rows');
  });

  it('無効化したルールは判定の対象から外れる (実 DB の enabled 条件)', async () => {
    // テナントとエージェント
    const a = await makeTenantWithAgent(repos, 'a');
    // 1 件作って外す
    const created = await repos.guardrailRules.create(
      {
        tenantId: a.tenantId,
        agentId: a.agent.id,
        kind: RuleKind.cost,
        threshold: 1_000,
        windowMinutes: 60,
        action: RuleAction.stop,
      },
      LIMITS,
    );
    expect(created.status).toBe('created');
    if (created.status !== 'created') return;
    await repos.guardrailRules.setEnabled(a.tenantId, created.rule.id, false, RULES_MAX);
    // 有効なルールの取得に出てこない (＝評価の起点から見えない)
    expect(
      await repos.guardrailRules.findActiveRules(a.tenantId, { agentId: a.agent.id }),
    ).toHaveLength(0);
    // 一覧には残る (設定画面から戻せる必要がある)
    const listed = await repos.guardrailRules.list(a.tenantId, { limit: 10 });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.enabled).toBe(false);
  });

  it('CHECK 制約が範囲外のしきい値と集計窓を拒否する', async () => {
    // テナントとエージェント
    const a = await makeTenantWithAgent(repos, 'a');
    // 集計窓 0 分 (幅ゼロの窓は 1 件も拾わないので永久に発火しない = fail-open)
    await expect(
      repos.guardrailRules.create(
        {
          tenantId: a.tenantId,
          agentId: null,
          kind: RuleKind.cost,
          threshold: 1_000,
          windowMinutes: 0,
          action: RuleAction.stop,
        },
        LIMITS,
      ),
    ).rejects.toThrow();
    // エラー率のしきい値 1.5 (エラー率は 1 を超えないので永久に発火しない)
    await expect(
      repos.guardrailRules.create(
        {
          tenantId: a.tenantId,
          agentId: null,
          kind: RuleKind.error_rate,
          threshold: 1.5,
          windowMinutes: 60,
          action: RuleAction.stop,
        },
        LIMITS,
      ),
    ).rejects.toThrow();
  });

  it('発火はインシデントの記録とエージェントの停止を同時に行う', async () => {
    // テナントとエージェント
    const a = await makeTenantWithAgent(repos, 'a');
    // stop のルール
    const created = await repos.guardrailRules.create(
      {
        tenantId: a.tenantId,
        agentId: a.agent.id,
        kind: RuleKind.cost,
        threshold: 1_000,
        windowMinutes: 60,
        action: RuleAction.stop,
      },
      LIMITS,
    );
    if (created.status !== 'created') throw new Error('ルールを作れませんでした');
    // 発火させる
    const raised = await repos.incidents.raise({
      tenantId: a.tenantId,
      agentId: a.agent.id,
      ruleId: created.rule.id,
      summary: 'コストが上限を超えました',
      suspendAgent: true,
    });
    // 記録され、停止もされている
    expect(raised?.suspended).toBe(true);
    expect(raised?.incident.status).toBe(IncidentStatus.open);
    // エージェントの状態が suspended になっている
    const agent = await repos.agents.findById(a.tenantId, a.agent.id);
    expect(agent?.status).toBe(AgentStatus.suspended);
  });

  it('同じルールで開いているインシデントがあれば新しい行を作らない (実 DB)', async () => {
    // **memory 側と対にする検査** (ADR-0006 の死角対策)。超過は解消するまで続くので、
    // 判定のたびに行を作ると記録と通知が溢れる
    const a = await makeTenantWithAgent(repos, 'a');
    // notify のルール (停止しないので条件が自己収束しない = いちばん溢れる形)
    const created = await repos.guardrailRules.create(
      {
        tenantId: a.tenantId,
        agentId: a.agent.id,
        kind: RuleKind.cost,
        threshold: 1_000,
        windowMinutes: 60,
        action: RuleAction.notify,
      },
      LIMITS,
    );
    if (created.status !== 'created') throw new Error('ルールを作れませんでした');
    // 同じ発火を 3 回
    const raises = [];
    for (let round = 0; round < 3; round += 1) {
      raises.push(
        await repos.incidents.raise({
          tenantId: a.tenantId,
          agentId: a.agent.id,
          ruleId: created.rule.id,
          summary: 'コストが上限を超えました',
          suspendAgent: false,
        }),
      );
    }
    // 1 回目だけが新規で、以降は同じ行を指す
    expect(raises.map((raised) => raised?.created)).toEqual([true, false, false]);
    expect(new Set(raises.map((raised) => raised?.incident.id)).size).toBe(1);
    // 実 DB の行も 1 件だけ
    const listed = await repos.incidents.list(a.tenantId, { limit: 10 });
    expect(listed.items).toHaveLength(1);
    // 解決すれば次はまた新しい行を作る
    await repos.incidents.resolve(a.tenantId, listed.items[0].id);
    const afterResolve = await repos.incidents.raise({
      tenantId: a.tenantId,
      agentId: a.agent.id,
      ruleId: created.rule.id,
      summary: 'コストが上限を超えました',
      suspendAgent: false,
    });
    expect(afterResolve?.created).toBe(true);
    expect((await repos.incidents.list(a.tenantId, { limit: 10 })).items).toHaveLength(2);
  });

  it('重複排除は停止を止めない (実 DB。開いている間に復帰させたら再び止める)', async () => {
    // **ここを一緒に抑えると「超過しているのに動いている」状態が残る**
    const a = await makeTenantWithAgent(repos, 'a');
    const created = await repos.guardrailRules.create(
      {
        tenantId: a.tenantId,
        agentId: a.agent.id,
        kind: RuleKind.cost,
        threshold: 1_000,
        windowMinutes: 60,
        action: RuleAction.stop,
      },
      LIMITS,
    );
    if (created.status !== 'created') throw new Error('ルールを作れませんでした');
    // 1 回目: 記録して停止
    const first = await repos.incidents.raise({
      tenantId: a.tenantId,
      agentId: a.agent.id,
      ruleId: created.rule.id,
      summary: '超過',
      suspendAgent: true,
    });
    expect(first).toMatchObject({ created: true, suspended: true });
    // 人が復帰させる (インシデントは開いたまま)
    await repos.agents.setStatus(a.tenantId, a.agent.id, AgentStatus.active);
    // 2 回目: 行は作らないが停止はやり直す
    const second = await repos.incidents.raise({
      tenantId: a.tenantId,
      agentId: a.agent.id,
      ruleId: created.rule.id,
      summary: '超過',
      suspendAgent: true,
    });
    expect(second).toMatchObject({ created: false, suspended: true });
    expect((await repos.agents.findById(a.tenantId, a.agent.id))?.status).toBe(
      AgentStatus.suspended,
    );
  });

  it('手動停止中のエージェントは自動停止で状態を塗り替えない', async () => {
    // テナントとエージェント
    const a = await makeTenantWithAgent(repos, 'a');
    // 手動で停止しておく
    await repos.agents.setStatus(a.tenantId, a.agent.id, AgentStatus.stopped);
    // notify ではなく stop のルール
    const created = await repos.guardrailRules.create(
      {
        tenantId: a.tenantId,
        agentId: a.agent.id,
        kind: RuleKind.cost,
        threshold: 1,
        windowMinutes: 60,
        action: RuleAction.stop,
      },
      LIMITS,
    );
    if (created.status !== 'created') throw new Error('ルールを作れませんでした');
    // 発火させる
    const raised = await repos.incidents.raise({
      tenantId: a.tenantId,
      agentId: a.agent.id,
      ruleId: created.rule.id,
      summary: 'コストが上限を超えました',
      suspendAgent: true,
    });
    // 記録はされるが、状態は変えない (誰が止めたのかが読めなくなるため)
    expect(raised?.suspended).toBe(false);
    const agent = await repos.agents.findById(a.tenantId, a.agent.id);
    expect(agent?.status).toBe(AgentStatus.stopped);
  });

  it('インシデントを持つルールは消せない (Restrict)', async () => {
    // テナントとエージェント
    const a = await makeTenantWithAgent(repos, 'a');
    // ルールを作って発火させる
    const created = await repos.guardrailRules.create(
      {
        tenantId: a.tenantId,
        agentId: a.agent.id,
        kind: RuleKind.cost,
        threshold: 1,
        windowMinutes: 60,
        action: RuleAction.notify,
      },
      LIMITS,
    );
    if (created.status !== 'created') throw new Error('ルールを作れませんでした');
    await repos.incidents.raise({
      tenantId: a.tenantId,
      agentId: a.agent.id,
      ruleId: created.rule.id,
      summary: '発火',
      suspendAgent: false,
    });
    // 「なぜ止まったか」の記録が消えるので、ルールは消せない
    expect(await repos.guardrailRules.delete(a.tenantId, created.rule.id)).toBe('restricted');
  });

  it('エージェントを消すとそのエージェント向けのルールも消える (Cascade)', async () => {
    // **memory 側がこの挙動を持っているかを確かめる相手**（ADR-0006 の死角を閉じる正本）
    const a = await makeTenantWithAgent(repos, 'a');
    // そのエージェント向けのルールと、テナント全体のルールを 1 本ずつ
    const scoped = await repos.guardrailRules.create(
      {
        tenantId: a.tenantId,
        agentId: a.agent.id,
        kind: RuleKind.cost,
        threshold: 1,
        windowMinutes: 60,
        action: RuleAction.notify,
      },
      LIMITS,
    );
    const tenantWide = await repos.guardrailRules.create(
      {
        tenantId: a.tenantId,
        agentId: null,
        kind: RuleKind.error_rate,
        threshold: 0.5,
        windowMinutes: 60,
        action: RuleAction.notify,
      },
      LIMITS,
    );
    if (scoped.status !== 'created' || tenantWide.status !== 'created') {
      throw new Error('ルールを作れませんでした');
    }
    // 履歴が無いので消せる
    expect(await repos.agents.delete(a.tenantId, a.agent.id)).toBe('deleted');
    // **エージェント向けのルールは消え、テナント全体のルールは残る**
    const rules = await repos.guardrailRules.list(a.tenantId, { limit: 50 });
    expect(rules.items.map((row) => row.id)).toEqual([tenantWide.rule.id]);
  });

  it('インシデントを持つエージェントは消せない (Restrict)', async () => {
    // テナントとエージェント
    const a = await makeTenantWithAgent(repos, 'a');
    // ルールを作って発火させる（利用イベントは作らない = インシデントだけが履歴）
    const created = await repos.guardrailRules.create(
      {
        tenantId: a.tenantId,
        agentId: a.agent.id,
        kind: RuleKind.cost,
        threshold: 1,
        windowMinutes: 60,
        action: RuleAction.notify,
      },
      LIMITS,
    );
    if (created.status !== 'created') throw new Error('ルールを作れませんでした');
    await repos.incidents.raise({
      tenantId: a.tenantId,
      agentId: a.agent.id,
      ruleId: created.rule.id,
      summary: '発火',
      suspendAgent: false,
    });
    // 「なぜ止まったか」の記録が消えるので、エージェントも消せない
    expect(await repos.agents.delete(a.tenantId, a.agent.id)).toBe('restricted');
  });

  it('インシデントの解決は 1 度だけ成功する', async () => {
    // テナントとエージェント
    const a = await makeTenantWithAgent(repos, 'a');
    // ルールを作って発火させる
    const created = await repos.guardrailRules.create(
      {
        tenantId: a.tenantId,
        agentId: a.agent.id,
        kind: RuleKind.cost,
        threshold: 1,
        windowMinutes: 60,
        action: RuleAction.notify,
      },
      LIMITS,
    );
    if (created.status !== 'created') throw new Error('ルールを作れませんでした');
    const raised = await repos.incidents.raise({
      tenantId: a.tenantId,
      agentId: a.agent.id,
      ruleId: created.rule.id,
      summary: '発火',
      suspendAgent: false,
    });
    if (!raised) throw new Error('発火できませんでした');
    // 1 回目は解決できる
    expect(await repos.incidents.resolve(a.tenantId, raised.incident.id)).toBe('resolved');
    // 2 回目は「既に解決済み」(監査ログに同じ操作を二重に残さないため)
    expect(await repos.incidents.resolve(a.tenantId, raised.incident.id)).toBe('already_resolved');
  });

  it('他テナントのインシデントは見えないし解決もできない', async () => {
    // 2 つのテナント
    const a = await makeTenantWithAgent(repos, 'a');
    const b = await makeTenantWithAgent(repos, 'b');
    // テナント a で発火させる
    const created = await repos.guardrailRules.create(
      {
        tenantId: a.tenantId,
        agentId: a.agent.id,
        kind: RuleKind.cost,
        threshold: 1,
        windowMinutes: 60,
        action: RuleAction.notify,
      },
      LIMITS,
    );
    if (created.status !== 'created') throw new Error('ルールを作れませんでした');
    const raised = await repos.incidents.raise({
      tenantId: a.tenantId,
      agentId: a.agent.id,
      ruleId: created.rule.id,
      summary: '発火',
      suspendAgent: false,
    });
    if (!raised) throw new Error('発火できませんでした');
    // テナント b からは見えない (存在を隠す)
    expect(await repos.incidents.findById(b.tenantId, raised.incident.id)).toBeNull();
    // 解決もできない
    expect(await repos.incidents.resolve(b.tenantId, raised.incident.id)).toBe('not_found');
  });

  it('監査ログは連番と連鎖が繋がり、検証が通る', async () => {
    // テナント
    const a = await makeTenantWithAgent(repos, 'a');
    // 3 行追記する
    const first = await appendAudit(a.tenantId, 'agent.suspend', a.adminId);
    const second = await appendAudit(a.tenantId, 'agent.resume', a.adminId);
    const third = await appendAudit(a.tenantId, 'guardrail.create', a.adminId);
    // 連番は 1 から 1 ずつ増える
    expect([first.seq, second.seq, third.seq]).toEqual([1n, 2n, 3n]);
    // 連鎖が繋がっている
    expect(first.prevHash).toBeNull();
    expect(second.prevHash).toBe(first.hash);
    expect(third.prevHash).toBe(second.hash);
    // 検証が通る
    expect(await verify(a.tenantId)).toEqual({ ok: true, verified: 3 });
  });

  it('テナントごとに連番が独立している', async () => {
    // 2 つのテナント
    const a = await makeTenantWithAgent(repos, 'a');
    const b = await makeTenantWithAgent(repos, 'b');
    // 交互に追記する
    await appendAudit(a.tenantId, 'a1');
    const b1 = await appendAudit(b.tenantId, 'b1');
    const a2 = await appendAudit(a.tenantId, 'a2');
    // どちらも自分のテナントの中で 1 から始まる
    expect(b1.seq).toBe(1n);
    expect(a2.seq).toBe(2n);
    // それぞれの連鎖が独立に検証できる
    expect(await verify(a.tenantId)).toEqual({ ok: true, verified: 2 });
    expect(await verify(b.tenantId)).toEqual({ ok: true, verified: 1 });
  });

  it('改ざん検知: 追記専用トリガが UPDATE を拒否する', async () => {
    // テナントと 1 行
    const a = await makeTenantWithAgent(repos, 'a');
    const row = await appendAudit(a.tenantId, 'agent.suspend');
    // 生 SQL で書き換えようとする (アプリの Port には更新のメソッドが無いので、DB へ直接当てる)
    await expect(
      client.$executeRaw`UPDATE "AuditLog" SET action = 'tampered' WHERE id = ${row.id}`,
    ).rejects.toThrow(/追記専用/);
  });

  it('改ざん検知: 追記専用トリガが宣言なしの DELETE を拒否する', async () => {
    // テナントと 1 行
    const a = await makeTenantWithAgent(repos, 'a');
    const row = await appendAudit(a.tenantId, 'agent.suspend');
    // 宣言のないトランザクションからの削除は拒否される
    await expect(client.$executeRaw`DELETE FROM "AuditLog" WHERE id = ${row.id}`).rejects.toThrow(
      /allow_audit_delete/,
    );
  });

  it('改ざん検知: トリガを外して書き換えると連鎖の検証が落ちる', async () => {
    // **この検査が無いと検出網の中心が空洞になる。** トリガだけを見ていると
    // 「改ざんできないので検知も試せない」で終わり、連鎖の検証が実際に働くことを一度も確かめない。
    // ここでは意図的にトリガを外して 1 行を書き換え、検証がその位置を指すことを見る
    const a = await makeTenantWithAgent(repos, 'a');
    // 3 行追記する
    await appendAudit(a.tenantId, 'a1');
    const second = await appendAudit(a.tenantId, 'a2');
    await appendAudit(a.tenantId, 'a3');
    // トリガを外す (表の所有者だけができる操作。アプリの経路からは到達しない)
    await client.$executeRaw`ALTER TABLE "AuditLog" DISABLE TRIGGER "AuditLog_append_only"`;
    try {
      // 2 行目の操作名だけを書き換える (ハッシュは古いまま)
      await client.$executeRaw`UPDATE "AuditLog" SET action = 'tampered' WHERE id = ${second.id}`;
    } finally {
      // 必ず戻す (以降のテストが追記専用でなくなると、この検査自体が意味を失う)
      await client.$executeRaw`ALTER TABLE "AuditLog" ENABLE TRIGGER "AuditLog_append_only"`;
    }
    // 検証は 2 行目で落ち、1 行目までしか確かめられていないと報告する
    expect(await verify(a.tenantId)).toEqual({
      ok: false,
      verified: 1,
      brokenSeq: 2n,
      reason: 'hash_mismatch',
    });
  });

  it('改ざん検知: トリガを外して行を消すと連鎖の検証が落ちる', async () => {
    // テナントと 3 行
    const a = await makeTenantWithAgent(repos, 'a');
    await appendAudit(a.tenantId, 'a1');
    const second = await appendAudit(a.tenantId, 'a2');
    await appendAudit(a.tenantId, 'a3');
    // トリガを外して 2 行目を消す
    await client.$executeRaw`ALTER TABLE "AuditLog" DISABLE TRIGGER "AuditLog_append_only"`;
    try {
      await client.$executeRaw`DELETE FROM "AuditLog" WHERE id = ${second.id}`;
    } finally {
      // 必ず戻す
      await client.$executeRaw`ALTER TABLE "AuditLog" ENABLE TRIGGER "AuditLog_append_only"`;
    }
    // 連番が 1 の次に 3 になっているので、削除として検知される
    expect(await verify(a.tenantId)).toEqual({
      ok: false,
      verified: 1,
      brokenSeq: 3n,
      reason: 'seq_not_sequential',
    });
  });

  it('宣言したトランザクションの中では監査ログを消せる (テナント消去の経路)', async () => {
    // テナントと 1 行
    const a = await makeTenantWithAgent(repos, 'a');
    await appendAudit(a.tenantId, 'agent.suspend');
    // 宣言したうえで削除する (テナント単位の消去要求に応えるための逃げ道)
    await client.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL agent_ops.allow_audit_delete = 'on'`;
      await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "tenantId" = ${a.tenantId}`;
    });
    // 消えている
    const { rows } = await repos.auditLogs.readChain(a.tenantId, CHAIN_LIMIT);
    expect(rows).toHaveLength(0);
  });

  it('同じ (tenantId, seq) の 2 行目は一意制約が拒否する', async () => {
    // テナントと 1 行
    const a = await makeTenantWithAgent(repos, 'a');
    const row = await appendAudit(a.tenantId, 'a1');
    // 同じ連番の行を直接差し込もうとする (採番のロックが外れた場合に起きる形)
    await expect(
      client.$executeRaw`
        INSERT INTO "AuditLog" (id, "tenantId", action, "targetType", "targetId", "createdAt", seq, hash)
        VALUES ('dup-row-1', ${a.tenantId}, 'x', 'Agent', 'ag', now(), ${row.seq}, 'h')
      `,
    ).rejects.toThrow();
  });

  it('窓の集計は呼び出し回数・失敗回数・料金を同時に返す', async () => {
    // テナントとエージェント
    const a = await makeTenantWithAgent(repos, 'a');
    // 成功 2 件と失敗 1 件を記録する
    for (const statusCode of [200, 200, 500]) {
      await repos.usageEvents.record({
        tenantId: a.tenantId,
        agentId: a.agent.id,
        provider: Provider.anthropic,
        model: MODEL,
        inputTokens: 10,
        outputTokens: 20,
        costMicroUsd: 1_000n,
        latencyMs: 5,
        statusCode,
      });
    }
    // 十分広い窓で集計する
    const totals = await repos.usageEvents.windowTotals(a.tenantId, {
      start: new Date(Date.now() - 60 * 60 * 1000),
      endExclusive: new Date(Date.now() + 60 * 1000),
    });
    // 3 件のうち 1 件が失敗、料金は 3,000 マイクロ USD
    expect(totals).toEqual({ requests: 3, errorRequests: 1, costMicroUsd: 3_000n });
  });

  // **停止を伴わない判定で既に開いている記録があるときは、エージェント行を押さえない。**
  // `notify` のルールは超過が解消するまで自分では止まらないので、窓のあいだ中継 1 回ごとに
  // `raise` へ来る。毎回ロックを取ると同じエージェントへの中継が 1 件ずつ直列化して
  // スループットが「DB の往復 1 回ぶん」に落ちる (しかも結果は毎回 created: false で捨てられる)。
  // ロックの有無は結果に現れないので、**別のトランザクションで同じ行を掴んだまま呼んで
  // 「待たされないこと」**を見る (上のロックの存在を見る検査と逆向きの手口)
  it('開いている記録があるなら、エージェント行を掴まれていても待たされない (notify の中継経路)', async () => {
    // テナント・エージェント・ルール
    const a = await makeTenantWithAgent(repos, 'fast');
    const created = await repos.guardrailRules.create(
      {
        tenantId: a.tenantId,
        agentId: a.agent.id,
        kind: RuleKind.cost,
        threshold: 1_000,
        windowMinutes: 60,
        action: RuleAction.notify,
      },
      LIMITS,
    );
    expect(created.status).toBe('created');
    if (created.status !== 'created') return;
    // 1 度発火させて「開いている記録」を作る (停止はしない)
    const first = await repos.incidents.raise({
      tenantId: a.tenantId,
      agentId: a.agent.id,
      ruleId: created.rule.id,
      summary: '1 回目',
      suspendAgent: false,
    });
    expect(first?.created).toBe(true);
    // ロックを離す合図
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 掴んだ合図
    let signalHeld = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    // 別のトランザクションでエージェント行を掴んだまま待つ
    const holding = client.$transaction(
      async (tx) => {
        // `raise` のトランザクションが取るのと同じ行・同じ強さのロック
        await tx.$queryRaw`SELECT status FROM "Agent" WHERE "tenantId" = ${a.tenantId} AND id = ${a.agent.id} FOR NO KEY UPDATE`;
        // 掴めたことを知らせる
        signalHeld();
        // 合図が来るまで保持する
        await released;
      },
      { timeout: LOCK_TEST_TRANSACTION_TIMEOUT_MS },
    );
    // 掴むまで始めない
    await held;
    try {
      // 2 回目 (近道が効いていればロックを待たずに返る)
      const again = repos.incidents.raise({
        tenantId: a.tenantId,
        agentId: a.agent.id,
        ruleId: created.rule.id,
        summary: '2 回目',
        suspendAgent: false,
      });
      // **待たされないこと** (近道が無ければ時間切れの方が先に返る)
      const finishedFirst = await Promise.race([
        again.then(() => 'returned' as const),
        new Promise<'blocked'>((resolve) =>
          setTimeout(() => resolve('blocked'), LOCK_TEST_WAIT_MS),
        ),
      ]);
      expect(finishedFirst).toBe('returned');
      // 答えは下の経路と同じ (新しい行は作らず、停止もしない)
      expect(await again).toMatchObject({ created: false, suspended: false });
    } finally {
      // 失敗しても必ず離す (掴んだまま抜けると次のテストの TRUNCATE が道連れで落ちる)
      release();
      await holding;
    }
    // 行は 1 件のまま
    const listed = await repos.incidents.list(a.tenantId, { limit: 10 });
    expect(listed.items).toHaveLength(1);
  });

  // 上のテストは追記が直列に流れるため、**採番のロック句を落としても緑のまま通る** (実測で 19 件すべて緑)。
  // そこで「同じテナント行を別のトランザクションが掴んでいる間、追記が待たされる」ことを決定的に確かめる —
  // ロックが無ければ待たずに終わるので、ロック句の削除がここで赤くなる
  // (repositories の「最後の admin」判定と同じ手口。理由も同じ)
  it('同じテナント行を掴んでいる間、監査ログの追記は待たされる (採番のロックの存在)', async () => {
    // テナントを 1 つ
    const a = await makeTenantWithAgent(repos, 'lock');
    // ロックを離す合図
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    // ロックを掴んだ合図 (掴む前に追記を始めると、どちらが先に行を取るかは運になり誤った赤が出る)
    let signalHeld = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    // 別のトランザクションでテナント行を掴んだまま待つ
    const holding = client.$transaction(
      async (tx) => {
        // 追記が取るのと同じ行・同じ強さのロック
        await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${a.tenantId} FOR NO KEY UPDATE`;
        // 掴めたことを知らせる
        signalHeld();
        // 合図が来るまで保持する
        await released;
      },
      { timeout: LOCK_TEST_TRANSACTION_TIMEOUT_MS },
    );
    // 掴むまで追記を始めない
    await held;
    // 追記を始める (ロックが効いていれば、掴んでいる間は終わらない)
    const appending = appendAudit(a.tenantId, 'agent.suspend');
    try {
      // 待たされていること (先に時間切れの方が返る)
      const finishedFirst = await Promise.race([
        appending.then(() => 'appended' as const),
        new Promise<'blocked'>((resolve) =>
          setTimeout(() => resolve('blocked'), LOCK_TEST_WAIT_MS),
        ),
      ]);
      expect(finishedFirst).toBe('blocked');
    } finally {
      // 失敗しても必ず離す (掴んだまま抜けると、次のテストの TRUNCATE が道連れで落ちる)
      release();
      await holding;
    }
    // ロックを離した後は追記が通る
    expect((await appending).seq).toBe(1n);
  });

  it('窓の集計は他テナントの行を数えない', async () => {
    // 2 つのテナント
    const a = await makeTenantWithAgent(repos, 'a');
    const b = await makeTenantWithAgent(repos, 'b');
    // テナント b にだけ記録する
    await repos.usageEvents.record({
      tenantId: b.tenantId,
      agentId: b.agent.id,
      provider: Provider.anthropic,
      model: MODEL,
      inputTokens: 10,
      outputTokens: 20,
      costMicroUsd: 9_999n,
      latencyMs: 5,
      statusCode: 500,
    });
    // テナント a の窓には 1 件も入らない
    const totals = await repos.usageEvents.windowTotals(a.tenantId, {
      start: new Date(Date.now() - 60 * 60 * 1000),
      endExclusive: new Date(Date.now() + 60 * 1000),
    });
    expect(totals).toEqual({ requests: 0, errorRequests: 0, costMicroUsd: 0n });
  });
});
