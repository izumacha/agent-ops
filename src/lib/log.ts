// ログの出口。**`console` を呼ぶのは `src/` 全体でこのファイルだけ**（`tests/error-logging.test.ts`）。
//
// **なぜ出口を 1 か所にしたか。** 以前は 15 ファイル・37 か所が直接 `console.error('[tag] 説明', …)`
// を呼んでいた。文言は人間向けの散文なので、運用者がログ収集に載せても (a) 出来事の種類で
// 集計・警報を作れない（文言の部分一致に頼るしかなく、推敲すると壊れる）、(b) 行が構造を持たない
// ので時刻・深刻度・出来事の識別子を機械で読めない。出口を 1 本にして**閉じた語彙**（`LOG_EVENTS`）
// を通すと、警報の条件が `event` の等値比較になり、文言の推敲で壊れなくなる。
//
// **検出網は狭まらない。** 直接 `console` を呼んでいた頃の規則（実引数はリテラル /
// 置換の無いテンプレート / `describeError(...)` だけ）はこのファイルの中でそのまま効き、
// 加えて「`console` を呼べるのはこのファイルだけ」「呼び出し側は `LOG_EVENTS` のキーと
// `describeError(...)` しか渡せない」が増える＝**規則は強くなる**。例外に触れられるのは
// 相変わらず `describeError` だけなので、PII や接続情報が流れる経路は増えない。
//
// **出力は常に 1 行 1 JSON**（環境で分けない）。分けると本番だけを通る経路ができ、そこは
// 手元では一度も確かめられない（このリポジトリが「CI の緑が判断材料にならない fail-open」
// として繰り返し記録している形）。読みにくさの代償は承知の上で、1 つの経路に寄せる。
//
// **このファイルの import は意図して最小に保つ（いまは `metrics.ts` だけ）。** ここは
// `src/domain` からも呼ばれるので、`constants.ts` のような大きなモジュールを取り込むと
// 純粋ロジック側の推移依存がそこへ一気に広がる（実測: 取り込んだ版では seed の import グラフが
// 9 ファイル増え、`tests/docker-seed-files.test.ts` が落ちた）。設定値の下限のような数値は
// 文言に埋め込まず**定数の名前**で指す（運用者はその名前で引ける。notify の既存の文言と同じ流儀）。
import { incrementCounter } from '@/lib/metrics';

/** ログの深刻度。**`error` は「運用者が対処すべき」、`warn` は「縮退して続けた」** */
export type LogLevel = 'error' | 'warn';

/** 出来事 1 件の宣言 */
interface LogEventSpec {
  // 深刻度
  readonly level: LogLevel;
  // 人間向けの説明（警報の条件には使わない。条件に使うのは `event` のキー）
  readonly message: string;
}

/**
 * ログに出す出来事の**閉じた語彙**。ここに無い出来事は出せない（型が拒む）。
 *
 * **キーは `<サブシステム>.<何が起きたか>`** で、以前の `[tag]` の接頭辞をそのまま引き継ぐ。
 * **語彙を足したら必ずどこかで出す** — 宣言だけして使わない値は
 * `tests/error-logging.test.ts` が落とす（`src/domain/audit/action.ts` と同じ流儀）。
 */
export const LOG_EVENTS = {
  // --- API の入口 ---
  'api.unexpected_error': { level: 'error', message: '予期しないエラー' },
  // --- 認証 ---
  'auth.platform_token_too_short': {
    level: 'error',
    message:
      'PLATFORM_ADMIN_TOKEN が短すぎます (必要な長さは src/lib/constants.ts の PLATFORM_ADMIN_TOKEN_MIN_LENGTH)。無視します。',
  },
  // --- 課金（受信 Webhook） ---
  'billing.customer_unknown': {
    level: 'error',
    message: '受信した顧客 ID に対応するテナントがありません',
  },
  'billing.plan_undecidable': {
    level: 'error',
    message: '契約の変更イベントからプランを決められませんでした',
  },
  'billing.stale_cancellation': {
    level: 'error',
    message: 'いまの契約とは別のサブスクリプションの解約なので反映しません',
  },
  // --- 健康確認 ---
  'health.db_unreachable': { level: 'error', message: 'DB 到達性チェックに失敗' },
  // --- 監視（/metrics） ---
  'metrics.token_too_short': {
    level: 'error',
    message:
      'METRICS_TOKEN が短すぎます (必要な長さは src/lib/constants.ts の METRICS_TOKEN_MIN_LENGTH)。監視の入口を閉じます。',
  },
  // --- 評価（Step3） ---
  'evaluation.agent_status_not_2xx': {
    level: 'error',
    message: 'エージェントの上流が 2xx 以外のステータスを返しました',
  },
  'evaluation.agent_body_not_json': {
    level: 'error',
    message: 'エージェントの応答を JSON として解釈できませんでした',
  },
  'evaluation.agent_call_failed': {
    level: 'error',
    message: 'エージェントの呼び出しに失敗しました',
  },
  'evaluation.judge_status_not_2xx': {
    level: 'error',
    message: 'judge が 2xx 以外のステータスを返しました',
  },
  'evaluation.judge_body_not_json': {
    level: 'error',
    message: 'judge の応答を JSON として解釈できませんでした',
  },
  'evaluation.judge_text_missing': {
    level: 'error',
    message: 'judge の応答から本文を取り出せませんでした',
  },
  'evaluation.judge_call_failed': { level: 'error', message: 'judge の呼び出しに失敗しました' },
  // --- ガードレール（Step4） ---
  'guardrail.window_out_of_range': {
    level: 'error',
    message: '集計窓の長さが範囲外のルールを判定できませんでした',
  },
  'guardrail.incident_target_missing': {
    level: 'error',
    message: 'インシデントを記録できませんでした (対象が見つかりません)',
  },
  'guardrail.audit_write_failed': {
    level: 'error',
    message: '発火の監査ログを書けませんでした (AUDIT_HMAC_SECRET の設定を確認してください)',
  },
  'guardrail.rule_evaluation_failed': { level: 'error', message: 'ルールを判定できませんでした' },
  'guardrail.notify_failed': { level: 'error', message: '通知の送信に失敗しました' },
  'guardrail.evaluation_failed': {
    level: 'error',
    message: 'ガードレールの判定に失敗しました',
  },
  // --- 通知（Step4） ---
  'notify.response_drain_failed': {
    level: 'error',
    message: '応答本文を読み捨てられませんでした',
  },
  'notify.send_failed': { level: 'error', message: '通知を送れませんでした' },
  'notify.webhook_url_invalid': {
    level: 'error',
    message:
      'NOTIFY_WEBHOOK_URL の形が受け付けられません (https か非本番のループバック http のみ・資格情報付き URL は不可)',
  },
  'notify.mail_url_invalid': {
    level: 'error',
    message:
      'NOTIFY_MAIL_WEBHOOK_URL の形が受け付けられません (https か非本番のループバック http のみ・資格情報付き URL は不可)',
  },
  'notify.webhook_unsigned': {
    level: 'error',
    message:
      'NOTIFY_SIGNING_SECRET が未設定か短いため NOTIFY_WEBHOOK_URL へ送りませんでした (必要な長さは src/lib/constants.ts の NOTIFY_SIGNING_SECRET_MIN_LENGTH)',
  },
  'notify.mail_unsigned': {
    level: 'error',
    message:
      'NOTIFY_SIGNING_SECRET が未設定か短いため NOTIFY_MAIL_WEBHOOK_URL へ送りませんでした (必要な長さは src/lib/constants.ts の NOTIFY_SIGNING_SECRET_MIN_LENGTH)',
  },
  'notify.webhook_undelivered': {
    level: 'error',
    message: 'NOTIFY_WEBHOOK_URL の受け手へ通知が届きませんでした',
  },
  'notify.mail_undelivered': {
    level: 'error',
    message: 'NOTIFY_MAIL_WEBHOOK_URL の受け手へ通知が届きませんでした',
  },
  // --- プラン（Step6） ---
  'plan.unknown_plan': {
    level: 'warn',
    message: '未知の契約プランを最も厳しいプランとして扱いました',
  },
  // --- DB の結線 ---
  'prisma.pool_error': { level: 'error', message: '接続プールでエラー' },
  'prisma.connection_error': { level: 'error', message: 'コネクションでエラー' },
  // --- 中継（Step2） ---
  'proxy.usage_agent_missing': {
    level: 'error',
    message: '利用イベントを記録できませんでした (エージェントが見つかりません)',
  },
  'proxy.usage_record_failed': { level: 'error', message: '利用イベントの記録に失敗しました' },
  'proxy.usage_tokens_unreadable': {
    level: 'error',
    message: '上流の応答からトークン数を読めませんでした',
  },
  'proxy.upstream_response_too_large': {
    level: 'error',
    message: '上流の応答が上限を超えたため打ち切りました',
  },
  'proxy.upstream_response_not_utf8': {
    level: 'error',
    message: '上流の応答が UTF-8 として解釈できませんでした',
  },
  'proxy.upstream_call_failed': { level: 'error', message: '上流の呼び出しに失敗しました' },
  // --- ストリームの後始末 ---
  'stream.release_failed': {
    level: 'error',
    message: '上限超過後のストリーム解放に失敗しました',
  },
} as const satisfies Record<string, LogEventSpec>;

/** ログに出せる出来事の名前 */
export type LogEventName = keyof typeof LOG_EVENTS;

/**
 * ログ 1 行を組み立てる（JSON 文字列）。
 *
 * **`console` へ渡してよい形の 1 つ**として `tests/error-logging.test.ts` が名指しで許している。
 * 許せる理由は `describeError` と同じで、**受け取れる値が構造で縛られている**から:
 * 第 1 引数は閉じた語彙のキー、第 2 引数は `describeError` が作った診断だけ。
 * つまりこの関数を通る値に、例外の `message` や利用者の入力が混ざる経路が無い。
 *
 * **例外を投げない。** 失敗しうる操作は 2 つあり、**どちらも `try` の中に入れる**:
 * 時刻の整形（無効な `Date` の `toISOString()` は `RangeError`）と `JSON.stringify`
 * （循環参照・BigInt）。失敗したら時刻を**その場で取り直し**、診断を落とした最小の行へ縮退する
 * （`describeError` が throw しないのと同じ理由 — ログの整形で落ちると、`catch` の中なら
 * 本来の失敗が別の失敗に化ける）。**時刻を組み立てを `try` の外に置かない** — 外に置くと
 * 無効な `Date` を渡された時点で投げ、この縮退の経路に一度も入らない。
 * @param event 出来事の名前
 * @param described `describeError()` が作った診断（無い出来事もある）
 * @param now 行に入れる時刻
 * @returns 1 行の JSON
 */
export function formatLogLine(
  event: LogEventName,
  described?: Record<string, unknown>,
  now: Date = new Date(),
): string {
  // 語彙から深刻度と説明を引く（表に無いキーは型が拒むので既定値は要らない）
  const spec = LOG_EVENTS[event];
  // **時刻の整形も JSON 化も同じ try の中で行う**（前者は無効な Date で RangeError を投げる）
  try {
    // 行の骨組み。順番を固定して、目で追うときに読みやすくする
    const line: Record<string, unknown> = {
      ts: now.toISOString(),
      level: spec.level,
      event,
      message: spec.message,
    };
    // 診断があれば添える（無い出来事では鍵そのものを出さない）
    if (described !== undefined) line.error = described;
    // 1 行の JSON にして返す
    return JSON.stringify(line);
  } catch {
    // 時刻は**その場で取り直す** — 渡された `now` が無効な Date だと読み直しても同じく失敗する。
    // `new Date()` は必ず有効なので、この 4 項目（文字列だけ）は必ず JSON にできる
    return JSON.stringify({
      ts: new Date().toISOString(),
      level: spec.level,
      event,
      message: spec.message,
    });
  }
}

/**
 * 出来事をログへ出し、同時に数える。
 *
 * **数えるのはここ 1 か所** — 出口とカウンタを同じ関数に置くので、「ログには出たのに
 * メトリクスには出ない」食い違いが構造的に起きない。
 * @param event 出来事の名前
 * @param described `describeError()` が作った診断（省略可）
 */
export function logEvent(event: LogEventName, described?: Record<string, unknown>): void {
  // 深刻度をラベルに使う（語彙が閉じているので系列は増えない）
  incrementCounter('agentops_log_events_total', { event, level: LOG_EVENTS[event].level });
  // 1 行の JSON を stderr へ出す。**`console` を呼ぶのは src 全体でこの 1 行だけ**
  console.error(formatLogLine(event, described));
}
