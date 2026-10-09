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
  // --- ログの出口自身（`src/lib/log.ts`） ---
  'log.format_failed': {
    level: 'error',
    message:
      'ログ 1 行の整形に失敗したため、出来事の名前を伏せた縮退の行を出しました。呼び出し側が語彙のキー以外を渡しています。',
  },
  // --- 監査ログ ---
  'audit.secret_not_configured': {
    level: 'error',
    message: 'AUDIT_HMAC_SECRET が設定されていません。人の操作と課金の反映を 503 で断ります。',
  },
  // **「未設定」と「短すぎる」を 1 つにまとめない。** 直し方が違う（変数を足すのか、値を
  // 作り直すのか）のに、同じ `event` だと運用者はログからも
  // `agentops_log_events_total` からも区別できない。間引きの窓も出来事ごとなので、
  // まとめると一方の発生が他方の行を押し出す（監視トークンの 2 つと同じ分け方）
  'audit.secret_too_short': {
    level: 'error',
    message:
      'AUDIT_HMAC_SECRET が短すぎます (必要な長さは src/lib/constants.ts の AUDIT_HMAC_SECRET_MIN_LENGTH)。人の操作と課金の反映を 503 で断ります。',
  },
  // --- 課金（受信 Webhook） ---
  // **`level` は `warn`。** `STRIPE_WEBHOOK_SECRET` は「課金を繋ぐなら必須」の任意設定で、
  // 繋いでいない配備では未設定が正常。この行も未認証の誰でも（署名の無い POST で）引けるので、
  // `error` だと外からの走査でエラー率の警報が鳴る（`metrics.token_not_configured` と同じ）。
  // **課金を繋いでいる配備ではこの行が「受信が全滅している」合図**なので、警報の条件は
  // 深刻度ではなく `event` の等値で組む（`docs/deploy.md`）
  'billing.secret_not_configured': {
    level: 'warn',
    message: 'STRIPE_WEBHOOK_SECRET が設定されていません。課金の受信 Webhook を 503 で断ります。',
  },
  // **値を入れたのに短すぎる側は `error`。** 未設定は「繋いでいない配備では正常」だが、
  // こちらは設定ミスが確定する（しかも直し方が違う）。分ける理由は
  // `audit.secret_too_short` と同じ
  'billing.secret_too_short': {
    level: 'error',
    message:
      'STRIPE_WEBHOOK_SECRET が短すぎます (必要な長さは src/lib/constants.ts の BILLING_WEBHOOK_SECRET_MIN_LENGTH)。課金の受信 Webhook を 503 で断ります。',
  },
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
  'billing.signature_rejected': {
    level: 'warn',
    message:
      '課金の受信 Webhook の署名を受け付けませんでした (形・時刻・一致のどれでも同じ扱い)。続く増加は共有シークレットの設定ミス、またはなりすましの可能性があります。',
  },
  // --- 健康確認 ---
  'health.db_unreachable': { level: 'error', message: 'DB 到達性チェックに失敗' },
  // --- 画面のセッション（Server Action。**応答は数えられないのでログが唯一の出口**。
  // 理由は src/lib/uncounted-response-sources.ts。**この説明はこの節の 2 件にだけ当てはまる** —
  // Route Handler から出る出来事（課金の署名・監視トークン）の 401 は応答の系列に乗る） ---
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
  'metrics.token_rejected': {
    level: 'warn',
    message:
      '監視の読み取りトークンを受け付けませんでした (ヘッダが無い・Bearer でない・値が一致しない のいずれか)。続く増加は収集エージェントの設定ミス、または総当たりの可能性があります。',
  },
  // **`level` は `warn`。** `METRICS_TOKEN` は「監視を繋ぐなら必須」の任意設定で、繋いで
  // いない配備では**未設定が正常**。それでもこの行は未認証の誰でも（`/metrics` を叩くだけで）
  // 引けるので、`error` にすると**外からの走査でプラットフォームのエラー率の警報が鳴る**
  // （全部 `console.error` で出していた頃に踏んだのと同じ形）。設定したのに短すぎる側
  // （`metrics.token_too_short`）は「値を入れたのに使えない」＝設定ミスが確定するので `error`
  'metrics.token_not_configured': {
    level: 'warn',
    message:
      '監視の読み取りトークンが設定されていないため GET /api/v1/metrics を閉じています。環境変数 METRICS_TOKEN を設定してください。',
  },
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
// 整形そのものが失敗したときに名乗る出来事（**語彙の中の値**。下の `LOG_EVENTS` にある）。
// 語彙の外の綴りを出していた頃は、運用者が `LOG_EVENTS` と `docs/deploy.md` から警報を
// 組む以上**その行に当たる条件を書けず**、しかも数える側にも系列が無かった
// （元の名前で数えようとして `incrementCounter` が捨てている）ので、
// 「ログの出口自身が縮退した」というただ 1 行がどちらの出口からも見えなかった
const FALLBACK_LOG_EVENT = 'log.format_failed';
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
 * @param occurrence その窓の中での**通算件数**（`logEventThrottled` だけが渡す。0 なら載せない）
 * @returns 1 行の JSON
 */
function buildLogLine(
  event: LogEventName,
  described: Record<string, unknown> | undefined,
  now: Date,
  occurrence: number,
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
    // **通算件数があれば添える**（その窓で何件目か）。0 なら鍵を出さない。
    // これが無いと、間引いた時点で「1 件の打ち間違い」と「1 万件の総当たり」が同じ行になり、
    // 規模がどの出口にも残らない（画面側の出来事は系列も `/metrics` から読めない）
    if (occurrence > 0) line.occurrence = occurrence;
    // 1 行の JSON にして返す
    return JSON.stringify(line);
  } catch {
    // ここへ来るのは時刻の整形か JSON 化が失敗したときだけ（語彙の引きは上で縮退済み）。
    // 引けるなら表の文言を使う（診断が JSON にできなかっただけなら、文言は有用なまま）
    const spec: LogEventSpec | undefined = lookupLogEvent(event);
    // 時刻はその場で取り直す（`new Date()` は必ず有効）。深刻度は引けなければ最も重い側へ倒す。
    // **出来事の名前も `String(...)` で落とす** — 型の外から来た値（`BigInt` など）は
    // `JSON.stringify` が投げるので、そのまま載せると**この縮退の経路が同じ理由で投げる**。
    // ここが投げると「絶対に投げない」という約束が崩れ、`onPoolError`（要求の外。
    // `src/lib/prisma-client.ts`）から呼ばれた時にログを 1 行も残さずプロセスが落ちる
    return JSON.stringify({
      ts: new Date().toISOString(),
      level: spec?.level ?? FALLBACK_LOG_LEVEL,
      // **文字列へ落とす** — 型の外から来た値（`BigInt` など）は `JSON.stringify` が投げる。
      // `String(...)` 自体が投げる値（`toString` が例外を投げる）もありうるが、そこは
      // **外側の `formatLogLine` が覆う**（ここで try を重ねても、語彙の引き直しが先に
      // 投げるので意味が無い＝実測。守られない飾りは置かない）
      event: String(event),
      message: spec?.message ?? FALLBACK_LOG_MESSAGE,
    });
  }
}

/**
 * 1 行の JSON を組み立てる（**絶対に投げない**）。
 *
 * 中の `buildLogLine` は縮退の経路でも語彙を引き直すが、`Object.hasOwn` は鍵を文字列へ
 * 変換するので **`toString` が投げる値ではその受け皿の中で投げる**（実測）。だから
 * **もう 1 段包み、いちばん内側は値を 1 つも読まない定型の行**にしてある — 何が渡されても
 * 投げようがない形にすることで、「絶対に投げない」という約束を**別の検出網に依存させない**
 * （いまは全呼び出し口が語彙のキーのリテラルで、`tests/error-logging.test.ts` がそれを構文で
 * 要求するので到達しない）。投げると `onPoolError`（要求の外。`src/lib/prisma-client.ts`）
 * から呼ばれた時に**ログを 1 行も残さずプロセスが落ちる**。
 * @param event 出来事の名前（語彙のキー）
 * @param described 添える診断（`describeError` の戻り値。無ければ省略）
 * @param now 行に載せる時刻（既定はいま）
 * @param occurrence その窓での通算件数（0 なら載せない）
 * @returns 1 行の JSON
 */
export function formatLogLine(
  event: LogEventName,
  described?: Record<string, unknown>,
  now: Date = new Date(),
  occurrence = 0,
): string {
  try {
    // 通常の組み立て（語彙の引きと縮退はこの中）
    return buildLogLine(event, described, now, occurrence);
  } catch {
    // 出来事の名前にさえ触れない値（型の上では起きない）。**値を 1 つも読まない行**を返す
    return JSON.stringify({
      ts: new Date().toISOString(),
      level: FALLBACK_LOG_LEVEL,
      event: FALLBACK_LOG_EVENT,
      message: FALLBACK_LOG_MESSAGE,
    });
  }
}

/**
 * 出来事を 1 件数える（**カウンタ名とラベルの形をここ 1 か所に置く**）。
 *
 * **写しを 2 か所に持たない。** `logEvent` と `logEventThrottled` が各自で
 * `incrementCounter('agentops_log_events_total', { event, level })` を書いていたので、
 * ラベルを 1 つ足す・名前を変えるといった変更を片方だけ直すと、**間引く側だけが別の系列へ
 * 黙って落ちる**（運用者が警報に使えと案内されているのはまさにその系列）。出口の選び分けを
 * `writeLogLine` に寄せたのと対の整理。
 * @param level 深刻度（語彙から引いた値。行と同じものを渡す）
 * @param event 出来事の名前
 */
function countLogEvent(level: LogLevel, event: LogEventName): void {
  // 閉じた語彙なので系列は増えない（引けなければ呼び出し側が最も重い側へ倒している）
  incrementCounter('agentops_log_events_total', { event, level });
}

/**
 * 1 行を組み立てて `console` へ出す（**出口はこの関数だけ**）。
 *
 * **深刻度で `console` のメソッドを選ぶ。** 行の JSON には `level` が入っているが、
 * **配備先のログ基盤は `console` のメソッドで深刻度を付ける**（Vercel の runtime logs が
 * そう）。全部 `console.error` で出していた頃は、利用者がダッシュボードのトークンを 1 回
 * 打ち間違えただけで ERROR のレコードが立ち、プラットフォーム側のエラー率の警報が鳴った
 * — 「文書どおり `level` で見ている運用者」と「基盤の深刻度で見ている運用者」で答えが
 * 割れる。**1 行 1 JSON という形は変えない**（環境で分けないという決定はそのまま）。
 *
 * **この選び分けを呼び出し側へ写さない。** `logEvent` と `logEventThrottled` の 2 か所に
 * 同じ分岐を書いていたので、深刻度を 1 つ増やすと**片方だけ直した**時点で間引く側の行が
 * 黙って `console.error` へ落ちる（まさにこの分岐が塞いだ壊れ方が、間引く側だけで再発する）。
 *
 * **`console` へは `formatLogLine(...)` を直接渡す**（変数に入れない） —
 * `tests/error-logging.test.ts` は実引数の**形**で許しているため。
 * @param level 深刻度（呼び出し側が語彙から引いた値。ラベルと同じものを渡す）
 * @param event 出来事の名前
 * @param described 添える診断（無ければ undefined）
 * @param now 行に載せる時刻
 * @param occurrence その窓での通算件数（0 なら載せない）
 */
function writeLogLine(
  level: LogLevel,
  event: LogEventName,
  described: Record<string, unknown> | undefined,
  now: Date,
  occurrence: number,
): void {
  // 深刻度で出口のメソッドを選ぶ（行の形は同じ）
  if (level === 'warn') console.warn(formatLogLine(event, described, now, occurrence));
  else console.error(formatLogLine(event, described, now, occurrence));
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
  // 1 件数える（カウンタ名とラベルの形は `countLogEvent` が持つ）
  countLogEvent(level, event);
  // 1 行の JSON を出す（出口の選び分けは `writeLogLine` が持つ。通算件数は無いので 0）
  writeLogLine(level, event, described, new Date(), 0);
}

// 間引くときの窓（ミリ秒）。この長さを 1 つの窓として通算件数を数え直す
const THROTTLED_LOG_WINDOW_MS = 60_000;
// 出来事ごとの間引きの状態（プロセス内）。`at` は窓が始まった時刻、
// `count` はその窓の中で起きた**通算件数**（行にした回も含む）
interface ThrottleState {
  at: number;
  count: number;
}
const throttleStates = new Map<LogEventName, ThrottleState>();

/**
 * その通算件数で行を出すか（**2 の冪のときだけ出す**: 1, 2, 4, 8, 16 …）。
 *
 * **窓あたり 1 本（1 要求 1 行でも 1 度だけでもない形）では burst の規模が残らなかった。** 1 本目は「その前に抑えた件数」を
 * 載せられないので必ず 0 で、burst が**止まってしまうと**抑えた件数を載せる 2 本目が
 * 永久に来ない（実測の指摘）。つまり「1 人の打ち間違い 1 件」と「50 秒で 1 万件の
 * 総当たり」がまったく同じ 1 行になる — 画面側の出来事は系列も `/metrics` から
 * 読めないので、規模がどこにも残らない。
 *
 * **2 の冪で出すと、行の本数が log になり、最後の行の `occurrence` がそのまま規模になる。**
 * 1 万件なら 14 本（1,2,4,…,8192）で、最後の行が `occurrence: 8192` と言う。**止まっても
 * 既に出ているので、あとから流し込む仕組み（タイマー）が要らない** — サーバーレスでは
 * 実体が凍結されてタイマーが発火しないことがあるので、そこに頼らない形を選んだ。
 * @param count 窓の中での通算件数（1 以上）
 * @returns 行を出すなら true
 */
function isReportableOccurrence(count: number): boolean {
  // 2 の冪かどうか（1 以上の整数で、下位ビットが 1 つだけ立っているか）
  return count >= 1 && (count & (count - 1)) === 0;
}

/**
 * 出来事を**数えつつ、行は間引いて**出す（窓の中の通算件数が 2 の冪の回だけ）。
 *
 * **これが既定の出口。** 未認証で誰でも叩ける経路の「断った」記録と「設定が使えない」記録は
 * どちらもここを通る。1 要求 1 行で出すと匿名の相手がログの量（＝保存の費用）を好きなだけ
 * 増やせるので間引くが、**1 度きりにはしない** — どちらも「いま続いているか」と規模が
 * 運用者の知りたいことで（共有シークレットのローテーション漏れも鍵の設定漏れも直すまで続く）、
 * 窓ごとに出し直せば続いていることが分かる。
 *
 * **1 プロセスに 1 度だけ（`logEventOnce`）でよいのは、率を別の出口から読める出来事だけ**
 * （いまは入口の読めないパスの 404。率は前段のアクセスログが 1 件ずつ持つ）。
 *
 * **数える側は毎回**なので、率そのものは `agentops_log_events_total{event=…}` に残る。
 * **ただしその系列が読めるかは呼び出し元の束による**（`logEvent` の説明にある実測）:
 * Route Handler から出る分は `/metrics` が読む実体と同じだが、**Server Action・入口から
 * 出る分は別実体なので永久に現れない**。さらにサーバーレスでは引きに行く収集そのものが
 * 成り立たない（`docs/deploy.md`）。
 *
 * **だから行そのものに通算件数（`occurrence`）を載せ、2 の冪の回だけ出す**
 * （1, 2, 4, 8 …。理由は `isReportableOccurrence`）。行の本数は log に収まり、
 * **最後の行の `occurrence` がそのまま規模**になるので、「1 件の打ち間違い」と
 * 「1 万件の総当たり」が同じ行にならない（画面側の出来事では系列も読めないので、
 * 行が唯一の運び手）。**窓を越えると通算件数は 1 へ戻る**ので、続いているあいだは
 * 窓ごとに必ず 1 本出る。
 * @param event 出来事の名前
 */
export function logEventThrottled(event: LogEventName): void {
  // いまの時刻（単調増加でなくてよい。窓の粗い刻みにしか使わない）
  const now = Date.now();
  // この出来事の間引きの状態（初回は無い）
  const state = throttleStates.get(event);
  // 窓が始まってからの経過。**壁時計なので負になりうる**（NTP の巻き戻し・ライブマイグレーション）
  const elapsed = state === undefined ? undefined : now - state.at;
  // 窓の中か。**負の経過は「窓を越えた」として扱う** — `elapsed < 窓` だけを見ていると、
  // 時計が 1 時間巻き戻った配備でその 1 時間ぶん行が 1 本も出なくなる（しかもサーバーレスでは
  // この行が唯一の読める信号なので、運用者が原因を調べたいまさにその時間が沈黙する）
  const inWindow =
    state !== undefined &&
    elapsed !== undefined &&
    elapsed >= 0 &&
    elapsed < THROTTLED_LOG_WINDOW_MS;
  // 窓の中なら通算件数を 1 つ進め、越えたら新しい窓の 1 件目にする
  const count = inWindow && state !== undefined ? state.count + 1 : 1;
  // 状態を更新する（窓を越えたときだけ開始時刻を取り直す）
  throttleStates.set(event, { at: inWindow && state !== undefined ? state.at : now, count });
  // 深刻度は語彙から引く（出口と同じ引き方。引けなければ最も重い側へ倒す）
  const level = lookupLogEvent(event)?.level ?? FALLBACK_LOG_LEVEL;
  // **数えるのは毎回**（行にしなかった回も率に残す。名前とラベルは `countLogEvent` が持つ）
  countLogEvent(level, event);
  // 2 の冪の回だけ行にする（それ以外は数えるだけで戻る）
  if (!isReportableOccurrence(count)) return;
  // 1 行出す。**通算件数（`occurrence`）を添える**ので、最後の行がそのまま規模を表す。
  // **`logEvent` へ渡さずここで出す** — あちらは件数を知らないので、通してしまうと
  // 数えるのが 2 度になるか、件数を載せる引数を公開の署名へ足すことになる
  writeLogLine(level, event, undefined, new Date(now), count);
}

// 既に 1 度出した出来事（プロセス内）。`logEventOnce` が使う
const loggedOnce = new Set<LogEventName>();

/**
 * 出来事を**1 プロセスに 1 度だけ**行にする（2 度目以降は何もしない）。
 *
 * **使えるのは「率が別の出口で回収できる」出来事だけ。** いま該当するのは入口が返す
 * 読めないパスの 404 で、その率は**前段のアクセスログが 1 件ずつ持っている**（アプリ側の
 * 1 行が解いているのは「この配備が 404 にした」という非可視だけ）。
 *
 * **設定ミスにも「断った」記録にも使わない。** どちらも直すまで／続くあいだの**率そのものが
 * 信号**で、1 度きりだとその 1 行を取りこぼした配備では以降どの出口にも何も現れず、
 * `agentops_log_events_total` も 1 で止まる（行を出した回だけ数えるため）。
 * そこは `logEventThrottled`（窓の中の通算件数が 2 の冪の回だけ行にする）を使う — 量は
 * 窓あたり対数に収まるので、匿名の相手にログの量を決めさせる心配も無い。
 *
 * **つまり 2 つの出口を分ける軸は「率を別の場所から読めるか」の 1 つだけ。**
 * 以前は「設定の通知か、断った記録か」で分けていたが、設定ミスのほうがむしろ
 * 「直すまで続き、続いていることが知りたい」側だった（鍵の設定漏れで受信 Webhook が全滅し、
 * 事業者がエンドポイントを無効化して解約が反映されない形）。
 * @param event 出来事の名前
 */
export function logEventOnce(event: LogEventName): void {
  // 既に出していれば何もしない
  if (loggedOnce.has(event)) return;
  // 出したことを覚える（**出す前に覚える** — 出口が投げても 2 度目を出さない）
  loggedOnce.add(event);
  // 1 行出す（深刻度・文言・出口の選び分けは `logEvent` が持つ）
  logEvent(event);
}

/**
 * テスト用に間引きの記憶を忘れる（**窓の記憶と「1 度だけ」の記憶の両方**）。
 *
 * **片方だけ戻す形にしない** — 先に走ったテストが出した 1 度きりの行のせいで、
 * 次のテストが「設定ミスを記録している」ことを確かめられなくなる（実測でそうなっていた）。
 * **本番の経路からは呼ばない**（`resetMetricsForTesting` と同じ扱い）。
 */
export function resetThrottledLogsForTesting(): void {
  // 本番で呼べると、間引きを外して好きなだけ行を出せるようになる
  if (process.env.NODE_ENV === 'production') {
    throw new Error('resetThrottledLogsForTesting は本番では使えません。');
  }
  // 次のテストでも 1 本目が出るように空へ戻す
  throttleStates.clear();
  // 「1 度だけ」の記憶も空へ戻す
  loggedOnce.clear();
}
