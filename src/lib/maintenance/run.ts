// 保守の定期実行の本体（`POST /maintenance/run` が呼ぶ。ADR-0016）。
//
// **2 つの「誰も呼ばない後片付け」をここ 1 か所に集める。**
//
// 1. **ガードレールの定期掃き**（ADR-0010 の宿題）— 判定は中継と評価実行の直後に走るので通常は
//    それで足りるが、**集計窓から古い行が抜けるだけでしきい値を越える**ルールがある。
//    たとえばエラー率を 1 時間の窓で見るルールは、成功した古い呼び出しが窓から外れると
//    新しい要求が 1 件も無くても率が上がる（品質も同じで、良い実行が抜けると平均が下がる）。
//    **使われなくなったエージェントはその瞬間に判定を起こす要求が無い**ので、起点が
//    「イベントの直後」だけだと永久に発火しない（fail-open）。
// 2. **レート制限の記録の回収**（ADR-0015 の宿題）— `consume` は**そのキーの**期限切れを同じ
//    操作の中で片付けるので通常は膨らまないが、**二度と来ないキー**（解約したテナント・一度だけ
//    来た主体）の行は誰も消さない。インプロセスの表だった頃は全キーを一定間隔で自動回収して
//    いたので、これは共有ストアへ移したときに**失った分**を取り戻す手当て。
//
// **1 要求でやる仕事には必ず上限を置き、続きはカーソルで次の要求へ渡す**（§8）。全件を 1 要求で
// やる形にすると、配備が育つほど 1 回が長くなっていずれ実行時間上限に当たり、**途中で切れた
// ことは応答に現れない**ので掃きが静かに効かなくなる。
import type { CursorKey, Repositories } from '@/data';
import { encodeCursor } from '@/data/page';
import { AgentStatus, RuleKind } from '@/domain/types';
import { rateLimitWindowMs } from '@/lib/api/rate-limit';
import {
  MAINTENANCE_RATE_LIMIT_SWEEP_BATCH,
  MAINTENANCE_RATE_LIMIT_SWEEP_MAX_BATCHES,
  PAGE_LIMIT_MAX,
} from '@/lib/constants';
import { evaluateGuardrailsSafely } from '@/lib/guardrail/evaluate';

// 全種別を見る。**enum から導く**ので、種別を足したときにここへ書き足す必要が無い
// （明示実行 `POST /guardrails/run` と同じ理由・同じ形）
const ALL_RULE_KINDS: readonly RuleKind[] = Object.values(RuleKind);

/** 保守の定期実行の入力（続きの位置と 1 要求ぶんの予算） */
export interface MaintenanceRunInput {
  /**
   * 続きのテナント（前回応答の `nextTenantCursor`）。省略すると先頭から＝**新しい一巡の開始**。
   *
   * **レート制限の記録の回収は一巡の開始でだけ行う。** 毎ページで回収すると、テナント数の多い
   * 配備では同じ掃きを何十回も繰り返すことになる（消す行はもう無いので空振りだが、
   * そのぶん DELETE が走る）
   */
  tenantCursor?: CursorKey;
  // 続きのエージェント（前回応答の `nextAgentCursor`）。`tenantCursor` の次のテナントの中の位置
  agentCursor?: CursorKey;
  // この要求で判定するエージェント数の上限（呼び出し側で 1〜最大値に正規化済み）
  agentBudget: number;
  // 判定の基準時刻（集計窓の終端。含まない）
  now: Date;
}

/** 保守の定期実行の結果 */
export interface MaintenanceRunResult {
  // 消したレート制限の記録の件数（一巡の開始以外では 0）
  rateLimitHitsDeleted: number;
  /**
   * 回収しきったか。`false` なら**まだ消せる行が残っている**（1 要求のバッチ数の上限で
   * 打ち切った）。そのときは**テナントを 1 件も歩かずに**戻るので、`passComplete` も偽・
   * カーソルも両方 `null` になる（呼び出し側は同じ呼び方をもう一度するだけでよい）
   */
  rateLimitSweepComplete: boolean;
  // 判定したエージェントの件数
  agentsEvaluated: number;
  // 判定しきったルールの件数（全エージェントぶんの合計）
  rulesEvaluated: number;
  // 発火したルールの件数（全エージェントぶんの合計）
  fired: number;
  /**
   * 判定できなかったルールの件数（例外で飛ばしたもの）＋**判定そのものが失敗した**
   * エージェントの件数。
   *
   * **0 でないことを呼び出し側へ必ず伝える** — 伝えないと「何も超過していない」と
   * 見分けの付かない応答になり、運用者は上限内だと読む（`POST /guardrails/run` が
   * 同じ理由で 500 にしているのと同じ事情）
   */
  failed: number;
  /**
   * **やることが何も残っていないか。** 呼び出し側はこの旗が真になるまで繰り返す。
   *
   * **カーソルの `null` では表せない。** 記録の回収が 1 要求のバッチ数の上限で打ち切られた
   * ときは、**テナントを 1 件も歩かずに**「続きは先頭から」（カーソルは両方 `null`）で戻る。
   * `null` に「終わった」と「先頭から」の 2 つの意味を持たせると、**その状態が「一巡が
   * 終わった」と読まれて回収の残りが永久に消えない**（しかも応答のどこにも現れない）。
   */
  passComplete: boolean;
  // 続きのテナント（`null` は先頭のテナントから。`passComplete` が真なら意味を持たない）
  nextTenantCursor: string | null;
  // 続きのエージェント（`null` ならそのテナントの先頭から）
  nextAgentCursor: string | null;
}

/**
 * レート制限の記録のうち、どの窓にも入らない行を上限付きで回収する。
 *
 * **境目は窓の長さから導く**（`rateLimitWindowMs`）。`before` を新しくしすぎると**生きている
 * 記録を消して枠をリセットしてしまう**ので、「窓の長さぶん前」より古い行だけを消す。
 * @param repos データ層
 * @param now 基準時刻
 * @returns 消した件数と、回収しきったか
 */
async function sweepRateLimitHits(
  repos: Repositories,
  now: Date,
): Promise<{ deleted: number; complete: boolean }> {
  // どの窓にも入らない境目（窓の長さぶん前）
  const before = new Date(now.getTime() - rateLimitWindowMs());
  // 消した合計
  let deleted = 0;
  // バッチ数の上限まで繰り返す
  for (let batch = 0; batch < MAINTENANCE_RATE_LIMIT_SWEEP_MAX_BATCHES; batch += 1) {
    // 1 バッチぶん消す
    const removed = await repos.rateLimit.sweep(before, MAINTENANCE_RATE_LIMIT_SWEEP_BATCH);
    // 合計へ足す
    deleted += removed;
    // 上限未満しか返らなければ、もう消せる行は無い
    if (removed < MAINTENANCE_RATE_LIMIT_SWEEP_BATCH) return { deleted, complete: true };
  }
  // 上限まで消してもまだ残っている（次の要求が続ける）
  return { deleted, complete: false };
}

/** 判定の進み具合（結果を組み立てるのに使う可変の集計） */
interface Progress {
  agentsEvaluated: number;
  rulesEvaluated: number;
  fired: number;
  failed: number;
}

/**
 * 保守の定期実行を 1 要求ぶんだけ進める。
 *
 * **エージェント 1 件ごとの判定は fail-safe な包み（`evaluateGuardrailsSafely`）を通す** —
 * 1 件の失敗で残りのエージェントを判定しないのは、保守の掃きとしては最悪の倒れ方
 * （1 テナントの壊れた行が配備全体の backstop を止める）。受け止めたことは `failed` で返す。
 *
 * **停止しているエージェントは判定しない。** 止まっているあいだは中継も評価も走らないので
 * 窓の集計は動かないうえ、発火しても「もう止まっている」だけ（`suspended` は偽になる）。
 * 判定の費用だけが掛かるので、絞って予算を生きているエージェントへ回す。
 * @param repos データ層
 * @param input 続きの位置と予算
 * @param env 環境変数（通知の設定を読む）
 * @returns 進めた結果と次のカーソル
 */
export async function runMaintenance(
  repos: Repositories,
  input: MaintenanceRunInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MaintenanceRunResult> {
  // 一巡の開始か（テナントのカーソルが無ければ先頭から）
  const startsPass = input.tenantCursor === undefined && input.agentCursor === undefined;
  // レート制限の記録の回収（一巡の開始でだけ行う。理由は入力の `tenantCursor`）
  const swept = startsPass
    ? await sweepRateLimitHits(repos, input.now)
    : { deleted: 0, complete: true };
  // 判定した件数の集計
  const progress: Progress = { agentsEvaluated: 0, rulesEvaluated: 0, fired: 0, failed: 0 };

  // 結果を組み立てる（掃きの結果と集計は共通で、違うのは続きの位置だけ）
  const build = (
    passComplete: boolean,
    nextTenantCursor: string | null,
    nextAgentCursor: string | null,
  ): MaintenanceRunResult => ({
    rateLimitHitsDeleted: swept.deleted,
    rateLimitSweepComplete: swept.complete,
    ...progress,
    passComplete,
    nextTenantCursor,
    nextAgentCursor,
  });

  // **回収が途中ならテナントを歩かずに戻る。** 歩いてしまうと、残りの回収は
  // 「次の一巡の開始」まで待つことになり、その一巡の最後の応答は `passComplete: true` を
  // 返す（回収の残りが応答のどこにも現れないまま消える）。先に回収を片付けることで、
  // 「やることが残っている」が**カーソルを 1 つも進めない形**で必ず呼び出し側へ伝わる
  if (!swept.complete) return build(false, null, null);

  // いま読んでいる位置（テナントは 1 件ずつ進める）
  let tenantCursor = input.tenantCursor;
  // エージェントのカーソルは最初に読むテナントだけに効く（2 件目以降は先頭から）
  let agentCursor = input.agentCursor;

  // 予算を使い切るか、テナントが尽きるまで進む
  while (progress.agentsEvaluated < input.agentBudget) {
    // テナントを 1 件だけ読む（1 件ずつ進めるので、残りのカーソルがそのまま次の位置になる）
    const tenants = await repos.tenants.list({ limit: 1, cursor: tenantCursor });
    const tenant = tenants.items[0];
    // 1 件も無ければ一巡が終わった
    if (tenant === undefined) return build(true, null, null);

    // このテナントの稼働中のエージェントを、残りの予算ぶんだけ読む
    // （1 ページの上限は超えない。`list` は正規化済みの件数を期待する）
    const remaining = input.agentBudget - progress.agentsEvaluated;
    const agents = await repos.agents.list(
      tenant.id,
      { limit: Math.min(remaining, PAGE_LIMIT_MAX), cursor: agentCursor },
      { status: AgentStatus.active },
    );
    // 1 件ずつ全種別を判定する
    for (const agent of agents.items) {
      await evaluateOneAgent(repos, tenant.id, agent.id, input.now, env, progress);
    }

    // このテナントにまだエージェントが残っていれば、**テナントのカーソルは進めない**
    // （進めると残りのエージェントがこの一巡では二度と判定されない＝取りこぼしが静かに起きる）
    if (agents.nextCursor !== undefined) {
      return build(
        false,
        tenantCursor === undefined ? null : encodeCursor(tenantCursor),
        agents.nextCursor,
      );
    }

    // このテナントは終わったので次のテナントへ（エージェントのカーソルは捨てる）
    tenantCursor = { createdAt: tenant.createdAt, id: tenant.id };
    agentCursor = undefined;
    // テナントが尽きていれば一巡が終わった
    if (tenants.nextCursor === undefined) return build(true, null, null);
  }

  // 予算を使い切った（次のテナントの先頭から続ける）
  return build(false, tenantCursor === undefined ? null : encodeCursor(tenantCursor), null);
}

/**
 * エージェント 1 件を全種別で判定し、結果を集計へ足す。
 * @param repos データ層
 * @param tenantId 判定するテナント
 * @param agentId 判定するエージェント
 * @param now 判定の基準時刻
 * @param env 環境変数
 * @param progress 集計（この関数が更新する）
 */
async function evaluateOneAgent(
  repos: Repositories,
  tenantId: string,
  agentId: string,
  now: Date,
  env: NodeJS.ProcessEnv,
  progress: Progress,
): Promise<void> {
  // 判定（例外は包みが受け止めてサーバログへ残す）
  const evaluation = await evaluateGuardrailsSafely(
    repos,
    // 人が起点ではないので操作主体は null（自動発火と同じ扱い）
    { tenantId, agentId, kinds: ALL_RULE_KINDS, now, actorId: null },
    env,
  );
  // 判定を試みた件数
  progress.agentsEvaluated += 1;
  // 包みが null を返したら、そのエージェントは 1 件も判定できていない
  if (evaluation === null) {
    progress.failed += 1;
    return;
  }
  // 集計へ足す
  progress.rulesEvaluated += evaluation.evaluated;
  progress.fired += evaluation.fired.length;
  progress.failed += evaluation.failed;
}
