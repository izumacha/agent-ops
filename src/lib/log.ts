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
  // --- 画面のセッション（Server Action。**応答は数えられないのでログが唯一の出口**。
  // 理由は src/lib/uncounted-response-sources.ts） ---
  'billing.signature_rejected': {
    level: 'warn',
    message:
      '課金の受信 Webhook の署名を受け付けませんでした (形・時刻・一致のどれでも同じ扱い)。続く増加は共有シークレットの設定ミス、またはなりすましの可能性があります。',
  },
  'metrics.token_rejected': {
    level: 'warn',
    message:
      '監視の読み取りトークンが一致しませんでした。続く増加は収集エージェントの設定ミス、または総当たりの可能性があります。',
  },
  'session.login_rejected': {
    level: 'warn',
    message:
      'ダッシュボードのログインを拒否しました (理由は区別しません)。続く増加は総当たりの可能性があります。',
  },
  'session.cross_origin_action': {
    level: 'warn',
    message: '別オリジンからの Server Action の送信を断りました',
  },
  // --- 入口（src/proxy.ts）。**接頭辞を `proxy.` にしない** — あちらは LLM の中継
  // （`src/app/api/v1/proxy`）で別のサブシステムなので、同じ接頭辞だと `proxy.*` の警報が
  // 2 つの無関係な出来事を混ぜる（上流の健康を見たいのに、壊れた URL の走査で鳴る） ---
  'entry.undecodable_path': {
    level: 'warn',
    message:
      'パスを percent-decode できない要求を 404 で返しました (以降は出しません)。同種の要求が続いているかは前段のアクセスログで確認してください。',
  },
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

// 語彙も引けなかったときの深刻度。**最も重い側へ倒す**（縮退した行を見落とさせない）
const FALLBACK_LOG_LEVEL: LogLevel = 'error';

/**
 * 語彙から宣言を引く。**自身のキーとして持つものだけを信用する。**
 *
 * **素の添字だと `Object.prototype` 由来の値が返る**（実測: `formatLogLine('constructor')` は
 * `level` も `message` も無い行を出し、`logEvent('valueOf')` はログに深刻度の無い行を出しながら
 * メトリクスには `level="error"` で数えた）。`spec.level` が `undefined` になるだけで
 * `TypeError` にならないので、素の添字のままでは縮退の経路へ一度も届かなかった。
 *
 * **守備範囲を正確に書く。** 上の実測は**縮退の受け（`spec?.level ?? …`）が無かった版**での
 * ものなので、いま `Object.hasOwn` を外しても**観測できる挙動は変わらない**（実測: 67 件すべて
 * 緑）— `Object.prototype.constructor` は `level` も `message` も持たないため、受けが
 * そのまま拾う。実際に約束（「語彙に無いキーでも必ず深刻度と文言が付く」）を支えているのは
 * **受けの側**で、そこを素の `spec.level` へ戻す変異は 7 件が落ちる（実測）。
 * この引きを残すのは**宣言した戻り値の型を本当のことにする**ため — 外すと `LogEventSpec`
 * ではない値が `LogEventSpec | undefined` として出ていき、次に `spec.level` と素で書いた人が
 * 受け取るのは `undefined` ではなく Object 由来の値になる（それが上の壊れた行の正体）。
 * `src/domain/plan.ts` の `planLimitsFor` と `tests/error-logging.test.ts` も同じ引き方。
 * @param event 出来事の名前（型の外から渡されることもある）
 * @returns 語彙の宣言（無ければ undefined）
 */
function lookupLogEvent(event: LogEventName): LogEventSpec | undefined {
  // 表が自身のキーとして持つものだけを返す
  return Object.hasOwn(LOG_EVENTS, event) ? LOG_EVENTS[event] : undefined;
}
// 語彙も引けなかったときの説明（表の文言が使えないので、何が起きたかだけを書く）
const FALLBACK_LOG_MESSAGE = 'ログ 1 行の整形に失敗したため、出来事の識別子だけを残しました';

/**
 * ログ 1 行を組み立てる（JSON 文字列）。
 *
 * **`console` へ渡してよい形の 1 つ**として `tests/error-logging.test.ts` が名指しで許している。
 * 許せる理由は `describeError` と同じで、**受け取れる値が構造で縛られている**から:
 * 第 1 引数は閉じた語彙のキー、第 2 引数は `describeError` が作った診断だけ。
 * つまりこの関数を通る値に、例外の `message` や利用者の入力が混ざる経路が無い。
 *
 * **例外を投げない。** 失敗しうる操作は 3 つあり、**どれも `try` の中に入れる**:
 * 語彙の引き（型の外から呼ばれると `undefined` で `spec.level` が TypeError）・
 * 時刻の整形（無効な `Date` の `toISOString()` は `RangeError`）・`JSON.stringify`
 * （循環参照・BigInt）。失敗したら時刻を取り直し、**語彙にも `now` にも触らない**最小の行へ
 * 縮退する（`describeError` が throw しないのと同じ理由 — ログの整形で落ちると、`catch` の
 * 中なら本来の失敗が別の失敗に化ける）。**どれ 1 つでも `try` の外に置かない** — 外に置くと
 * その失敗ではこの縮退の経路に一度も入らない（実際、時刻と語彙の 2 つで順に踏んだ）。
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
  // **失敗しうる操作はすべて同じ try の中で行う**:
  //   - 時刻の整形（無効な `Date` の `toISOString()` は RangeError）
  //   - JSON 化（循環参照・BigInt）
  try {
    // 語彙から深刻度と説明を引く。**`lookupLogEvent` を通す** — 素の添字だと
    // `Object.prototype` 由来の値が `LogEventSpec` として返るので、宣言した型が嘘になる
    // （下の `?? FALLBACK_…` が実際の縮退を担うことは `lookupLogEvent` の説明に書いた）
    const spec = lookupLogEvent(event);
    // 行の骨組み。順番を固定して、目で追うときに読みやすくする。
    // 引けなければ最も重い側へ倒し、文言も定型文で埋める（下の catch と同じ扱い）
    const line: Record<string, unknown> = {
      ts: now.toISOString(),
      level: spec?.level ?? FALLBACK_LOG_LEVEL,
      event,
      message: spec?.message ?? FALLBACK_LOG_MESSAGE,
    };
    // 診断があれば添える（無い出来事では鍵そのものを出さない）
    if (described !== undefined) line.error = described;
    // 1 行の JSON にして返す
    return JSON.stringify(line);
  } catch {
    // ここへ来るのは時刻の整形か JSON 化が失敗したときだけ（語彙の引きは上で縮退済み）。
    // 引けるなら表の文言を使う（診断が JSON にできなかっただけなら、文言は有用なまま）
    const spec: LogEventSpec | undefined = lookupLogEvent(event);
    // 時刻はその場で取り直す（`new Date()` は必ず有効）。深刻度は引けなければ最も重い側へ倒す
    return JSON.stringify({
      ts: new Date().toISOString(),
      level: spec?.level ?? FALLBACK_LOG_LEVEL,
      event,
      message: spec?.message ?? FALLBACK_LOG_MESSAGE,
    });
  }
}

/**
 * 出来事をログへ出し、同時に数える。
 *
 * **数えるのはここ 1 か所** — 出口とカウンタを同じ関数に置くので、同じモジュール実体の中では
 * 「ログには出たのにメトリクスには出ない」食い違いが起きない。
 *
 * **ただし実体をまたぐと起きる（実測）。** Next.js はアプリを**複数の束**へ分けて配るので、
 * `src/lib/metrics.ts` の系列も束ごとに別の実体になる。本番ビルドで確認した束は 3 つ:
 * (a) Route Handler（`src/app` 配下の `route.ts`。`/metrics` が読むのはこの実体）、
 * (b) 画面の描画と **Server Action**（`app` 配下の `page.js` が読む `chunks/ssr/` の束）、
 * (c) 入口（`src/proxy.ts`）。
 *
 * **つまり `agentops_log_events_total` に現れるのは (a) が実行した分だけ。**
 * `session.login_rejected` / `session.cross_origin_action` は Server Action からしか出ないので
 * **系列に永久に現れず**、`plan.unknown_plan` のように両方の層から出る出来事は**一部しか
 * 数えられない**。
 *
 * **だから `event` の警報はログの行で組む。** メトリクスの系列を条件にすると、(b) や (c) の
 * 出来事では一度も発火しない（`docs/deploy.md` の「監視を繋ぐ」にも同じことを書いてある）。
 * 応答の側で数えない種類の一覧は `src/lib/uncounted-response-sources.ts` が正本。
 * @param event 出来事の名前
 * @param described `describeError()` が作った診断（省略可）
 */
export function logEvent(event: LogEventName, described?: Record<string, unknown>): void {
  // 語彙から宣言を引く。**`formatLogLine` と同じく防御的に引く** — 以前はここで
  // `LOG_EVENTS[event].level` を直接読んでいたので、**語彙に無いキーではここで TypeError**（※）
  // になり、`formatLogLine` に入れた縮退の経路へ一度も届かなかった（固めたのは到達しない側）。
  // この関数は `catch` の中からも、`pg` のプール障害ハンドラ（要求の外。
  // `src/lib/prisma-client.ts`）からも呼ばれるので、投げると本来の失敗が別の失敗に化けるか、
  // 誰も捕まえられない例外になる
  const spec: LogEventSpec | undefined = lookupLogEvent(event);
  // ※ 正確には `Object.prototype` のキー（`constructor` / `valueOf` 等）では TypeError にも
  // ならず、深刻度も文言も無い行が出ていた。だから引きは `lookupLogEvent`（`Object.hasOwn`）に
  // 寄せてある。
  // 深刻度を 1 度だけ決める（**ラベルと出口の両方が同じ値を読む**。別に引くと、片方だけを
  // 差し替える変異が通る＝実測で `tests/log.test.ts` の一致の検査がそれを固定している）
  const level = spec?.level ?? FALLBACK_LOG_LEVEL;
  // 深刻度をラベルに使う（語彙が閉じているので系列は増えない。引けなければ最も重い側へ倒す）
  incrementCounter('agentops_log_events_total', { event, level });
  // 1 行の JSON を出す。**`console` を呼ぶのは src 全体でこの 2 行だけ**（どちらも stderr）。
  //
  // **深刻度で `console` のメソッドを選ぶ。** 行の JSON には `level` が入っているが、
  // **配備先のログ基盤は `console` のメソッドで深刻度を付ける**（Vercel の runtime logs が
  // そう）。全部 `console.error` で出していた頃は、利用者がダッシュボードのトークンを 1 回
  // 打ち間違えただけで ERROR のレコードが立ち、プラットフォーム側のエラー率の警報が鳴った
  // — 「文書どおり `level` で見ている運用者」と「基盤の深刻度で見ている運用者」で答えが
  // 割れる。**1 行 1 JSON という形は変えない**（環境で分けないという決定はそのまま）。
  if (level === 'warn') console.warn(formatLogLine(event, described));
  else console.error(formatLogLine(event, described));
}
