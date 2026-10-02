// ガードレールの判定の**唯一の入口**。3 つの起点（中継の直後・評価実行の直後・明示実行の API）が
// すべてこの関数を通るので、「どの順で何をするか」を 1 か所でしか決められない。
//
// **順序は固定**（受け入れ基準「発火から停止まで ≦ 3 秒」を守るため）:
//   1. 有効ルールを引く（0 件ならここで実質終わり。以降のループが 1 周もしない）
//   2. 種別ごとに窓を集計して判定する（同じ窓の長さは 1 回だけ問い合わせる。§8 N+1 回避）
//   3. 発火したルールごとに **インシデントの記録と自動停止**（アダプタが 1 トランザクションで行う）
//   4. 監査ログを書く
//   5. **通知は最後**（Webhook の往復を「発火 → 停止」の計測に入れない。受け手の応答時間は
//      こちらで決められないので、基準の 3 秒に外部の遅さを持ち込まない）
//
// **止める側は fail-closed、記録と通知は fail-open。** 通知の失敗や監査ログの失敗で停止を
// 取り消すと、Webhook の受け手が落ちているあいだ「超過しても止まらない」状態になり、
// 守るべきものが守れなくなる。
import type { GuardrailRuleRecord, Repositories } from '@/data/ports';
import { RuleAction, RuleKind } from '@/domain/types';
import { AuditAction, AuditTargetType } from '@/domain/audit/action';
import type { AuditPayload } from '@/domain/audit/chain';
import {
  evaluateRule,
  guardrailWindow,
  worstQualityScore,
  type GuardrailMeasurement,
  type RuleObservation,
} from '@/domain/guardrail/rule';
import { recordAudit } from '@/lib/audit/record';
import { GUARDRAIL_WINDOW_MAX_MINUTES, GUARDRAIL_WINDOW_MIN_MINUTES } from '@/lib/constants';
import { describeError } from '@/lib/describe-error';
import { notifyGuardrailIncident, type NotifyPayload } from '@/lib/notify/send';
import { guardrailIncidentSummary } from '@/lib/guardrail/summary';

/** 判定の起点が渡す材料 */
export interface GuardrailTrigger {
  // 判定するテナント（必ず入れる。ADR-0002）
  tenantId: string;
  // 判定対象のエージェント
  agentId: string;
  // 見る種別。**起点によって違う** — 中継の直後は cost / error_rate、評価の直後は quality、
  // 明示実行は全種別。関係のない種別まで見ると、中継 1 回ごとに評価実行の表まで引くことになる
  kinds: readonly RuleKind[];
  // 判定の基準時刻（集計窓の終端。含まない）
  now: Date;
  // 監査ログに残す操作主体。自動発火は null（人が起点の明示実行ではそのユーザー）
  actorId: string | null;
}

/** 発火した 1 件の結果 */
export interface FiredGuardrail {
  // 発火したルール
  ruleId: string;
  kind: RuleKind;
  action: RuleAction;
  // 記録したインシデント
  incidentId: string;
  // このルールでエージェントを停止したか（手動停止中は塗り替えないので false になりうる）
  suspended: boolean;
}

/** 判定の結果 */
export interface GuardrailEvaluation {
  // 判定したルールの件数（0 ならルールが無いか、この種別のルールが無い）
  evaluated: number;
  // 発火したルール（しきい値を越えなかったものは含まない）
  fired: FiredGuardrail[];
}

// 1 件も判定しなかったときの結果（毎回オブジェクトを作らない）
const NOTHING_EVALUATED: GuardrailEvaluation = { evaluated: 0, fired: [] };

/**
 * 中継の直後に見る種別（使用量から測れるもの）。品質だけは評価実行の表を見るので入れない —
 * 入れると中継 1 回ごとに評価実行の表まで引くことになり、しかも中継では品質は動かない
 */
export const USAGE_RULE_KINDS: readonly RuleKind[] = [RuleKind.cost, RuleKind.error_rate];

/**
 * 評価実行の直後に見る種別。中継では利用イベントしか増えないので、品質は評価の経路だけが見る。
 * **2 つの表を足し合わせると全種別になる**ことは `tests/guardrail-evaluate.test.ts` が
 * `RuleKind` から導いて確かめる（種別を足して結線を忘れると、そのルールは永久に発火しない）
 */
export const QUALITY_RULE_KINDS: readonly RuleKind[] = [RuleKind.quality];

/**
 * 1 つのルールの判定に必要な測定値をそろえる。
 *
 * **同じ窓の長さの集計は 1 回だけ問い合わせる**（`usageByWindow` に貯める）。ルールを
 * 「50% で通知、80% で停止」のように同じ窓で複数持つのが自然な使い方なので、ルールごとに
 * 問い合わせると件数ぶんのクエリが中継 1 回ごとに走る（§8 の N+1 回避）。
 */
async function measureFor(
  repos: Repositories,
  trigger: GuardrailTrigger,
  rule: GuardrailRuleRecord,
  usageByWindow: Map<number, { requests: number; errorRequests: number; costMicroUsd: bigint }>,
  quality: { loaded: boolean; score: number | null },
): Promise<GuardrailMeasurement | null> {
  // 品質ルールは窓を使わず、直近の「採点が成立した」評価実行を見る
  if (rule.kind === RuleKind.quality) {
    // まだ引いていなければ 1 回だけ引く（複数の品質ルールがあっても問い合わせは 1 回）
    if (!quality.loaded) {
      // 最新の completed な実行（1 度も実行していなければ null）
      const run = await repos.evaluations.findLatestCompletedRun(trigger.tenantId, trigger.agentId);
      // 3 観点のうち最も低い値を採る（1 つでも欠けていれば null = 測れていない）
      quality.score = worstQualityScore(run);
      // 2 回目以降はこの値を使う
      quality.loaded = true;
    }
    // 品質以外の項目はこのルールの判定では使われない（`observe` が種別で切り替える）
    return {
      requests: 0,
      errorRequests: 0,
      costMicroUsd: 0n,
      worstQualityScore: quality.score,
    };
  }
  // 使用量の種別は窓を組み立てる。**範囲外の長さなら判定しない**（null を返す）
  const window = guardrailWindow(
    trigger.now,
    rule.windowMinutes,
    GUARDRAIL_WINDOW_MIN_MINUTES,
    GUARDRAIL_WINDOW_MAX_MINUTES,
  );
  // 窓が作れなければこのルールは判定できない（呼び出し側がログに残す）
  if (window === null) return null;
  // 同じ長さの集計を使い回す
  const cached = usageByWindow.get(rule.windowMinutes);
  // 無ければ問い合わせて貯める
  const totals =
    cached ??
    (await repos.usageEvents.windowTotals(trigger.tenantId, {
      start: window.start,
      endExclusive: window.endExclusive,
      agentId: trigger.agentId,
    }));
  // 次のルールのために覚えておく
  if (cached === undefined) usageByWindow.set(rule.windowMinutes, totals);
  // 品質は測っていないので null（この種別の判定では読まれない）
  return { ...totals, worstQualityScore: null };
}

// 実測値を payload に入れられる形にする。**料金だけ文字列**にするのは BigInt が JSON に
// 載らないためで、金額を JSON で文字列にする既存の約束（ADR-0002）と同じ扱い
function observedForPayload(observation: RuleObservation): string | number {
  // 種別ごとに項目名と型が違う
  switch (observation.kind) {
    case RuleKind.cost:
      return observation.costMicroUsd.toString();
    case RuleKind.error_rate:
      return observation.rate;
    case RuleKind.quality:
      return observation.score;
  }
}

// 監査ログの payload を組み立てる。**平坦な辞書に限る**（入れ子はハッシュが不定に揺れる）
function auditPayloadFor(
  rule: GuardrailRuleRecord,
  observation: RuleObservation,
  suspended: boolean,
): AuditPayload {
  // 実測値（料金は文字列、割合とスコアは数値）
  const observed = observedForPayload(observation);
  // 判断の根拠だけを残す（機微情報は入れない）
  return {
    kind: rule.kind,
    action: rule.action,
    threshold: rule.threshold,
    windowMinutes: rule.windowMinutes,
    observed,
    suspended,
  };
}

/**
 * そのエージェントに掛かっているガードレールを判定し、超過していれば記録・停止・通知する。
 *
 * **例外を外へ出す経路は 2 つだけ**（どちらも呼び出し側が握る前提）: ルールの取得と集計で
 * DB が落ちている場合と、インシデントの記録が失敗した場合。中継の経路からは呼び出し側が
 * try/catch で包む（中継は成功しているのに 500 を返さないため）。
 */
export async function evaluateGuardrails(
  repos: Repositories,
  trigger: GuardrailTrigger,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GuardrailEvaluation> {
  // 見る種別が空なら問い合わせる必要も無い
  if (trigger.kinds.length === 0) return NOTHING_EVALUATED;
  // そのエージェントに掛かっている有効なルール（エージェント指定とテナント全体の和集合）
  const rules = await repos.guardrailRules.findActiveRules(trigger.tenantId, {
    agentId: trigger.agentId,
    kinds: trigger.kinds,
  });
  // **ルールが 0 件なら下のループが 1 周もしないので、集計も評価実行の読み出しも走らない。**
  // ここに `if (rules.length === 0) return` を置いていたが、**何も節約していなかった**
  // （変異で確かめたところ、消しても全 15 件が緑のまま通った）。ルールを設定していない
  // テナントの中継に掛かる追加費用は `findActiveRules` の 1 クエリだけで、それは
  // 「掛かっているルールがあるか」を知るために避けられない。
  // **測定を先読みする形へ変えないこと** — ループの外で窓を集計すると、ルールが 0 件の
  // テナントにも集計の費用が掛かる（その退行は tests/guardrail-evaluate.test.ts の
  // 「ルールが 1 件も無ければ集計もしない」が落とす）
  // 窓の長さごとの集計と、品質スコア（どちらも最大 1 回だけ問い合わせる）
  const usageByWindow = new Map<
    number,
    { requests: number; errorRequests: number; costMicroUsd: bigint }
  >();
  // 品質スコアは「まだ引いていない」状態から始める (null は「測れていない」を意味するので、
  // 引いたかどうかを別の真偽値で持つ)
  const quality: { loaded: boolean; score: number | null } = { loaded: false, score: null };
  // 発火したものを貯める
  const fired: FiredGuardrail[] = [];
  // 通知の材料を貯める（送るのは全件の記録と停止が終わってから）
  const notifications: NotifyPayload[] = [];
  // ルールを 1 つずつ判定する
  for (const rule of rules) {
    // 測定値をそろえる（窓が範囲外なら null）
    const measurement = await measureFor(repos, trigger, rule, usageByWindow, quality);
    // 窓が作れないルールは判定できない。**DB の CHECK 制約があるので通常は起きない**ので、
    // 起きたら設定が壊れている（制約を入れる前の行が残っている等）。黙って飛ばさずログに残す
    if (measurement === null) {
      console.error('[guardrail] 集計窓の長さが範囲外のルールを判定できませんでした');
      continue;
    }
    // しきい値を越えたか（向きは RULE_COMPARISON の表が決める）
    const evaluation = evaluateRule(rule.kind, rule.threshold, measurement);
    // 越えていなければ次のルールへ
    if (!evaluation.fired) continue;
    // 発火理由の 1 行（インシデントと通知が同じ文を使う）
    const summary = guardrailIncidentSummary(
      evaluation.observation,
      rule.threshold,
      rule.windowMinutes,
    );
    // **インシデントの記録と自動停止を 1 トランザクションで行う**（アダプタが担保する）
    const raised = await repos.incidents.raise({
      tenantId: trigger.tenantId,
      agentId: trigger.agentId,
      ruleId: rule.id,
      summary,
      // 停止するのは action が stop のルールだけ（notify は記録と通知のみ）
      suspendAgent: rule.action === RuleAction.stop,
    });
    // エージェントかルールが（並行して）消えていれば記録できない。握り潰さずログに残す
    if (raised === null) {
      console.error('[guardrail] インシデントを記録できませんでした (対象が見つかりません)');
      continue;
    }
    // 発火として数える
    fired.push({
      ruleId: rule.id,
      kind: rule.kind,
      action: rule.action,
      incidentId: raised.incident.id,
      suspended: raised.suspended,
    });
    // 監査ログを書く。**失敗しても停止は取り消さない** — 鍵が未設定なら `recordAudit` は 503 を
    // 投げるが、そこで中断すると「超過しても止まらない」状態になる。止める側を優先し、
    // 記録できなかったことをサーバログに残す（運用者が鍵を設定すれば次回から記録される）
    try {
      await recordAudit(
        repos,
        {
          tenantId: trigger.tenantId,
          actorId: trigger.actorId,
          action: AuditAction.guardrail_fired,
          targetType: AuditTargetType.incident,
          targetId: raised.incident.id,
          payload: auditPayloadFor(rule, evaluation.observation, raised.suspended),
        },
        env,
      );
    } catch (error) {
      // 鍵の未設定（503）も DB の障害も同じ扱い。**どの環境変数を直せばよいかを文言に書く**。
      //
      // 環境変数の名前を定数（`AUDIT_HMAC_SECRET_ENV`）から置換で埋めないのは、
      // `tests/error-logging.test.ts` の許可表へ 1 件足すことになるため。あの表は
      // 「静かに緩む口」としてこの repo が繰り返し見てきた形なので、文言の中へ直接書いて
      // 表を増やさない側を採る（通知の `src/lib/notify/send.ts` と同じ判断）。
      // **値ではなく名前なので、これは正本の写しではない**（値は secret.ts が読む）
      console.error(
        '[guardrail] 発火の監査ログを書けませんでした (AUDIT_HMAC_SECRET の設定を確認してください):',
        describeError(error),
      );
    }
    // 通知の材料を貯める（送信は最後）
    notifications.push({
      tenantId: trigger.tenantId,
      agentId: trigger.agentId,
      kind: rule.kind,
      incidentId: raised.incident.id,
      summary,
      suspended: raised.suspended,
      occurredAt: raised.incident.createdAt.toISOString(),
    });
  }
  // **通知はすべての記録と停止が終わってから**（受け手の応答時間を停止までの計測に入れない）。
  // 失敗しても結果は変えない（`notifyGuardrailIncident` は例外を外へ出さない）
  await Promise.all(notifications.map((payload) => notifyGuardrailIncident(payload, env)));
  // 判定した件数と発火したもの
  return { evaluated: rules.length, fired };
}

/**
 * 起点から呼ぶ **fail-safe な包み**。例外を外へ出さず、サーバログに残すだけ。
 *
 * 判定は「すでに成立した操作のあと」に走るので、ここで例外を投げると**成功した操作が
 * 失敗したことになる**: 中継の経路なら上流の課金は発生して応答も得たのに 500 を返し、
 * 評価の経路なら保存済みの実行を 500 で隠してしまう。どちらも「起きたことと返す答えが
 * 食い違う」形なので、判定の失敗は判定だけの失敗に閉じる。
 *
 * **止める側の fail-closed とは矛盾しない。** 止められなかったときに安全側へ倒す相手は
 * 「判定できたのに止めない」ことで、ここは「判定そのものが失敗した」場合。
 */
export async function evaluateGuardrailsSafely(
  repos: Repositories,
  trigger: GuardrailTrigger,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GuardrailEvaluation | null> {
  // 判定を試みる
  try {
    // 成功したら結果をそのまま返す（呼び出し側が使わなくてもよい）
    return await evaluateGuardrails(repos, trigger, env);
  } catch (error) {
    // DB の障害などで判定できなかったことを残す（黙って飛ばさない。§6）
    console.error('[guardrail] ガードレールの判定に失敗しました:', describeError(error));
    // 判定できなかったことを null で表す
    return null;
  }
}
