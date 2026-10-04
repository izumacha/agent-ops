// UI 文言と enum ラベルの一元管理 (§6)。画面・API のエラー文言はここから引く
import { MICRO_USD_MAX } from '@/domain/money';
import { JSON_BODY_MAX_DEPTH } from '@/lib/body-limits';
import { AgentStatus, Provider, Role, RuleKind } from '@/domain/types';
import { RATIO_MAX } from '@/domain/guardrail/rule';

// アプリ名 (画面タイトル等で使う)
export const APP_NAME = 'Agent Ops';

// 役割の日本語ラベル
export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  [Role.viewer]: '閲覧者', // viewer
  [Role.operator]: '運用者', // operator
  [Role.admin]: '管理者', // admin
};

// エージェント状態の日本語ラベル
export const AGENT_STATUS_LABELS: Readonly<Record<AgentStatus, string>> = {
  [AgentStatus.active]: '稼働中', // active
  [AgentStatus.stopped]: '停止中', // stopped
  [AgentStatus.suspended]: '自動停止', // suspended
};

// ガードレールのルール種別の日本語ラベル (インシデントの要約文と画面で使う)
export const RULE_KIND_LABELS: Readonly<Record<RuleKind, string>> = {
  [RuleKind.cost]: 'コスト超過', // cost
  [RuleKind.error_rate]: 'エラー率', // error_rate
  [RuleKind.quality]: '品質低下', // quality
};

// **`RuleAction` / `IncidentStatus` の日本語ラベルは置いていない。** 参照する場所がまだ無く
// （API は enum の値をそのまま JSON へ出し、画面は Step5）、置くと「使われない値」が増えるだけ
// （§6 デッドコードを残さない）。画面で必要になったときに、使う側と一緒に足す

// ─────────────────────────────────────────────
// API (Step1) の上限値と利用者向けエラー文言。Route Handler はここから引き、直書きしない
// ─────────────────────────────────────────────

// 一覧の既定件数 (OpenAPI の Limit パラメータの default と一致させる)
export const PAGE_LIMIT_DEFAULT = 50;
// 一覧の最大件数 (OpenAPI の Limit パラメータの maximum と一致させる。§8 一覧は必ず上限を持つ)
export const PAGE_LIMIT_MAX = 200;
// カーソル文字列の最大長 (ミリ秒と id を符号化した値なので十分。異常に長い値を弾く)
export const PAGE_CURSOR_MAX_LENGTH = 200;
// 表示名など短い文字列の上限 (OpenAPI の name / model 等の maxLength と一致させる)
export const SHORT_TEXT_MAX_LENGTH = 100;
// 説明文など長い文字列の上限 (OpenAPI の description の maxLength)
export const LONG_TEXT_MAX_LENGTH = 1000;
// メールアドレスの上限 (RFC 5321)
export const EMAIL_MAX_LENGTH = 254;
// ユーザートークンの既定の有効期間 (日)
export const USER_TOKEN_DEFAULT_TTL_DAYS = 90;
// ユーザートークンの有効期間の上限 (日)。無期限は作れない
export const USER_TOKEN_MAX_TTL_DAYS = 365;
// プラットフォーム管理者トークン (環境変数) に要求する最小長。短い値は設定ミスとみなして使わない (fail-closed)
export const PLATFORM_ADMIN_TOKEN_MIN_LENGTH = 32;
// ガードレールの集計窓の下限 (分)。0 や負の窓は「期間が無い」ので判定できない
export const GUARDRAIL_WINDOW_MIN_MINUTES = 1;
// ガードレールの集計窓の上限 (分 = 7 日)。**無制限の窓を許さない** (§8 / §9) —
// ルールの判定はプロキシの中継 1 回ごとに走るので、窓が伸びるほど毎回の集計が重くなる。
// 7 日を超える傾向は Step5 のダッシュボードが扱う領域で、即時の自動停止の材料ではない
export const GUARDRAIL_WINDOW_MAX_MINUTES = 60 * 24 * 7;
// コスト超過ルールのしきい値の上限 (マイクロ USD)。**`GuardrailRule.threshold` は倍精度浮動小数**
// なので、整数として正確に表せる範囲 (2^53-1) までに絞る。これを超えると「設定した額」と
// 「保存された額」が静かにずれる (約 90 億 USD 相当なので実用上の制約にはならない)
export const GUARDRAIL_COST_THRESHOLD_MAX = Number.MAX_SAFE_INTEGER;
// 1 テナントが持てるガードレールのルールの上限。**判定は中継 1 回ごとに走る**ので、
// ルールが増えるほど 1 回の呼び出しで回す集計が増える (§8 / §9)。
// 50 件は「種別 3 × エージェント十数件 ＋ テナント全体のルール」を十分に収める大きさ
export const GUARDRAIL_RULES_MAX_PER_TENANT = 50;
// 1 テナントが持てるガードレールのルールの**行数**の上限 (有効・無効を問わない)。
// **有効なルールの上限だけでは総行数が縛れない** — 無効化した行は上の上限に数えないので
// (発火済みのルールは削除できず、数えると枠が永久に空かない)、「作る → 無効化する」を繰り返すと
// 行が無制限に増える。有効な上限の 4 倍を行数の天井にして、どちらかに達したら 409 を返す
// (§9 のリソース枯渇の防止)。無効で発火記録も無い行は削除できるので、通常の運用で当たることはない
export const GUARDRAIL_RULE_ROWS_MAX_PER_TENANT = GUARDRAIL_RULES_MAX_PER_TENANT * 4;
// 連鎖の検証で 1 回に読む監査ログの上限。検証は 1 行目から順にたどるので途中から始められず、
// ページ送りができない。代わりに読む件数を区切り、上限に達したかを応答で伝える (§8)
export const AUDIT_CHAIN_VERIFY_MAX_ROWS = 10_000;
// 通知 1 回の待ち時間の上限 (ミリ秒)。**発火から停止までの計測には入らない** (通知は停止より後)
// が、受け手が黙り込んだときに発火の処理そのものが長引かないよう区切る
export const NOTIFY_TIMEOUT_MS = 5_000;
// 通知の応答本文を読む上限 (バイト)。受け手の応答に意味は無いので読んで捨てるだけ。
// 読まずに捨てると接続が滞留する実装があるので読むが、無制限に読むとメモリを食う
export const NOTIFY_MAX_RESPONSE_BYTES = 64 * 1024;
// 通知に付ける署名のヘッダ名。受け手が検証に使う (値は `sha256=<16 進>`)
export const NOTIFY_SIGNATURE_HEADER = 'x-agent-ops-signature';
// 通知の署名鍵 (環境変数 NOTIFY_SIGNING_SECRET) に要求する最小長。
// 短い鍵は総当たりで求められ、求められたら任意の通知を偽装できる
export const NOTIFY_SIGNING_SECRET_MIN_LENGTH = 32;
// プロキシ経路のレート制限: 1 つの API キーが窓の中で出せる中継の回数。
//
// 根拠は ADR-0007 の実測「本文を最悪の形に詰めた要求でも 1 通あたり 3.3ms」。1 分 600 回でも
// 1 プロセスあたり約 2 秒ぶんの計算量に収まる一方、上流の課金は 600 回ぶん発生するので、
// 「壊れたクライアントの暴走を止める」には十分に効く。正当な使い方（1 件ずつ中継する
// エージェント）には届かない高さに置いてある
export const PROXY_RATE_LIMIT_PER_MINUTE = 600;
// 上限を上書きできる環境変数の名前。**既定は上の定数**で、配備先ごとに上げ下げできる。
// 用途は (a) 運用者の調整、(b) ベンチ (scripts/bench-proxy.ts) が計測を妨げられないようにすること。
// **名前を定数にしてここに置くのは、ベンチが取り込めるようにするため** — ベンチの import は
// 許可リストで絞ってあり (tests/gate-scripts.test.ts)、実行時の副作用を持つモジュール
// (src/lib/api/rate-limit.ts は読み込み時に共有インスタンスを作る) は取り込めない。
// 綴りをベンチへ書き写すと写しが 2 つになるので、定数だけのこのファイルを共有する
export const PROXY_RATE_LIMIT_ENV = 'PROXY_RATE_LIMIT_PER_MINUTE';
// **重い経路には、上の枠に加えてもう 1 つ小さい枠を掛ける.** 回数だけを数える 1 つの枠では、
// 1 要求の重さが 2 桁違う経路を同じ上限で守れない。**ただし「重い」の中身は経路によって違い、
// 中身が違えば妥当な上限も違う**ので、理由ごとに枠を分ける（1 つに束ねると、どちらかの経路に
// とって必ず不適切な値になる）。
//
// (1) **上流へ扇状に出る経路**（`POST /evaluations`）。1 要求で最大
// EVALUATION_SET_MAX_CASES 件 × (生成 + 採点) の往復が走るので、600 要求ぶんの枠は
// 上流呼び出し 24 万回ぶんの枠と同じ意味になる。守りたいのは**ベンダーへの課金**なので、
// 「人が画面から押す操作としては十分、自動化された連打には届かない」ところに置く。
// **環境変数では上げ下げできない** — 上げたくなるのは「評価を連続で回したい」ときで、
// それは 1 要求のケース数を増やすか間隔を空ける方で解く（枠を広げると上の根拠が崩れる）
export const FAN_OUT_ROUTE_RATE_LIMIT_PER_MINUTE = 6;
// (2) **応答を返す前に外部の往復を待つ経路**（`POST /guardrails/run`）。**上流 LLM は呼ばないので
// 課金は増えない** — 重いのは「ルート数ぶんの集計クエリ」と「待っている通知の往復」で、
// 守りたいのは外部の応答時間がこの API の応答時間に乗ることと DB の負荷。(1) と同じ値にすると
// cron からの定期掃きが成り立たない（`POST /guardrails/run` は 1 要求 1 エージェントなので、
// エージェントが 20 件あるテナントの毎分の掃きは 20 要求になり、6 件で止まると残りは
// **その回は一度も判定されない** = backstop が静かに効かなくなる）。この経路の費用に見合う
// 高さに置き、1 要求 1 エージェントという形を変えるとき（テナント一括の受け口）に見直す
export const OUTBOUND_WAIT_ROUTE_RATE_LIMIT_PER_MINUTE = 60;
// (3) **1 要求で大量の行を読んで計算し直す経路**（`GET /audit-logs/verify`）。上流も外部も
// 呼ばないが、1 回で最大 AUDIT_CHAIN_VERIFY_MAX_ROWS 行を読み、その件数ぶん HMAC を計算し直す
// （一覧の上限 PAGE_LIMIT_MAX の 50 倍）。**費用は DB の読み取りと CPU** なので (1)(2) とは
// 性質が違う。検証は「運用者が確かめる」「日次の cron が区間ごとに回す」操作で、毎分の連打を
// 必要としない。10 件あれば 10 万行ぶんの区間を 1 分で確かめられるので、運用の都合には足りる
export const HEAVY_READ_ROUTE_RATE_LIMIT_PER_MINUTE = 10;
// レート制限の窓の長さ (ミリ秒)。1 分 = 上の定数の「1 分」の定義
export const RATE_LIMIT_WINDOW_MS = 60 * 1000;
// 監査ログのハッシュ連鎖に使う HMAC 鍵 (環境変数 AUDIT_HMAC_SECRET) に要求する最小長。
// 短い鍵は総当たりで求められ、求められた鍵があれば連鎖をまるごと作り直せるので検知の意味が消える。
// プラットフォーム管理者トークンと同じ 32 文字以上を要求する (別の値にする理由が無いので値も揃える)
export const AUDIT_HMAC_SECRET_MIN_LENGTH = 32;
// テナント作成時に最初の admin へ発行するログイントークンの用途名 (UserToken.name に保存され一覧に出る)
export const USER_TOKEN_BOOTSTRAP_NAME = '初期管理者トークン';
// 開発用 CLI (scripts/issue-user-token.ts) が発行するトークンの既定の用途名 (--name 省略時)
export const USER_TOKEN_CLI_NAME = 'CLI';
// 日次集計で一度に指定できる期間の上限 (日)。無制限の期間は全件走査になるので必ず区切る (§8 / §9)。
// 366 日 (うるう年を含む 1 年) は「昨年分をまとめて出す」という実際の使い方を 1 回で満たせる最小の値
export const USAGE_RANGE_MAX_DAYS = 366;
// ダッシュボード (Step5) が既定で見る期間 (日)。31 日は「ひと月ぶんを 1 画面で見る」という
// 使い方をちょうど満たす長さで、日次の表の行数もこの値で縛られる (§8 一覧は必ず上限を持つ)。
// 期間はクエリで変えられるが、上限は USAGE_RANGE_MAX_DAYS が引き続き効く
export const DASHBOARD_DEFAULT_RANGE_DAYS = 31;
// ダッシュボードが数える未解決インシデントの上限。**件数だけを知るための無制限の取得をしない**
// (§8 / §9) ので、ここまで数えて超えていれば画面は「〜件以上」と表示する。
// 一覧 1 ページぶん (PAGE_LIMIT_DEFAULT) と同じ値にしているのは、画面が「未解決の一覧」へ
// 遷移したときに見える件数と揃えるため (別の値にすると「40 件以上」と出たのに一覧には 50 件並ぶ)
export const DASHBOARD_OPEN_INCIDENTS_MAX = PAGE_LIMIT_DEFAULT;
// プロキシが上流 (Anthropic / OpenAI) の応答を待つ上限 (ミリ秒)。
// 上流が黙り込んだときに接続を抱え続けないための打ち切りで、生成が長引く呼び出しも通せるよう長めに取る
export const UPSTREAM_TIMEOUT_MS = 120_000;
// プロキシが上流の応答本文を読む上限 (バイト)。リクエスト側 (JSON_BODY_MAX_BYTES) と**別の値**にする —
// LLM の応答は入力より大きくなるのが普通なので、同じ値では正常な呼び出しを落としてしまう。
// 上限が無いと、壊れた前段ゲートウェイが巨大な本文を返したとき「同時リクエスト数 × 本文サイズ」の
// ヒープを一度に握り、タイムアウトまで解放されない (実測で 64 MiB を丸ごとバッファした)
export const UPSTREAM_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// 上流が申告するトークン数として受け付ける上限。**`prisma/schema.prisma` の
// `UsageEvent.inputTokens` / `outputTokens` が `Int` (PostgreSQL の integer = 2^31-1) なので、
// それより大きい値は保存できない。** 受け入れてしまうと記録が P2020 で落ち、`recordUsage` が
// それを飲むので**「上流の課金は発生しているのに台帳に 1 行も無い」**状態になる (実測で 0 行)。
// 上限を超えた申告は「トークン数を読めなかった」として扱い、料金 0 の行を必ず 1 行残す
// (ADR-0007 決定 5)。列の型を変えるときはここも合わせる
export const USAGE_TOKENS_MAX = 2_147_483_647;
// ─────────────────────────────────────────────
// 品質評価 (Step3) の上限値と既定値。judge の結線・実行の刻み方はここが唯一の参照元
// ─────────────────────────────────────────────

// 1 つの評価セットに入れられるケース数の上限。受け入れ基準の「固定評価セット 100 件」を
// 余裕をもって満たす件数の歯止め (§8/§9: 1 リクエストで無制限のケースを作らせない)。
//
// **この件数だけでは本文の大きさを縛れない。先に効くのは JSON_BODY_MAX_BYTES (64 KiB) のほう。**
// 1 ケースは input・expected とも最大 LONG_TEXT_MAX_LENGTH (1000 文字) 書けるので、長い本文を
// 並べれば 100 件に届く前に 413 になる (JSON の飾りを除いた 1 ケースあたりの取り分は、
// 200 件なら約 310 バイト、100 件でも約 640 バイト)。
// つまり**上限は「件数 200」と「本文 64 KiB」の小さいほう**で、短い入力なら件数が、
// 長い入力なら本文サイズが先に当たる。
// 本文の上限を上げて解く道は取らない — JSON_BODY_MAX_BYTES と ENTRY_MAX_BODY_BYTES は
// 未認証の相手に握らせるヒープを実測して決めた値 (src/lib/body-limits.ts) で、全経路に効く。
// 長いケースを並べたくなったら、全体を緩めるのではなくこの経路だけの上限を足すこと
export const EVALUATION_SET_MAX_CASES = 200;
// judge へ 1 回で採点させるケース数。**1 件ずつにしない** — ケース ID を返させる形が
// 成り立たなくなり、受け入れ基準が求める「幻覚 ID の除外」を試す経路そのものが消える。
// 大きすぎると 1 回の応答が長くなって解析に失敗しやすくなるので、その間を取る
export const EVALUATION_JUDGE_BATCH_SIZE = 10;
// 上流 (エージェント応答の生成・judge の採点) を同時に走らせる本数。
// 1 実行で最大 EVALUATION_SET_MAX_CASES 回の往復が起きるので、逐次だと待ち時間が積み上がる
export const EVALUATION_CONCURRENCY = 4;
// 評価が上流 1 回を待つ上限 (ミリ秒)。**プロキシ経路の UPSTREAM_TIMEOUT_MS (120 秒) を使わない** —
// 評価は 1 リクエストの中で「ケース数 ÷ 同時実行数」回ぶんの待ち時間が積み上がるので、
// 1 回あたりを長くすると実行全体が配備先の関数タイムアウトに届き、
// **上流には課金されたのに実行の記録が 1 行も残らない**状態になる (ADR-0009 の「残る境界」)。
// 生成は max_tokens を EVALUATION_AGENT_MAX_TOKENS / JUDGE_MAX_TOKENS に絞ってあるので短く済む
export const EVALUATION_UPSTREAM_TIMEOUT_MS = 30_000;
// 除外がこの割合を超えた実行は failed とする (採点として使えないため)。
// **0 ではなく 1 でもない**: 数件の除外で実行ごと捨てると回帰比較が途切れ、逆に全件除外でも
// completed のままだと「スコアが無い実行」が比較対象に並ぶ。半分を境にする
export const EVALUATION_MAX_EXCLUSION_RATE = 0.5;
// judge へ渡すエージェント応答の長さの上限 (文字)。超えた分は切り詰める。
// 上限が無いと、長い応答が 1 件あるだけで judge への本文が膨らみ、そのバッチ全体が失敗する
export const EVALUATION_RESPONSE_MAX_CHARS = 4000;
// 応答を切り詰めたことを示す印 (judge に「ここで切れている」と伝えるため本文へ足す)
export const EVALUATION_TRUNCATION_MARK = '…(以下省略)';
// judge の既定のプロバイダ (環境変数 JUDGE_PROVIDER で上書きできる)
export const JUDGE_DEFAULT_PROVIDER = Provider.anthropic;
// judge の既定のモデル (環境変数 JUDGE_MODEL で上書きできる)。採点は短い JSON を返すだけなので
// 安いモデルを既定にする。**綴りをコードへ散らさない** (§9 モデル名は定数か環境変数で管理する)
export const JUDGE_DEFAULT_MODEL = 'claude-haiku-4-5';
// judge に生成させる上限トークン数 (返すのは短い JSON なので小さくてよい)
export const JUDGE_MAX_TOKENS = 1024;
// 評価対象エージェントに生成させる上限トークン数
export const EVALUATION_AGENT_MAX_TOKENS = 1024;

// JSON 本文の上限 (バイト) の再公開。値そのものは `src/lib/body-limits.ts` が持つ
// (`next.config.ts` が import する都合で、あちらは `@/...` を含まない定数だけのファイルにしてある)
export { JSON_BODY_MAX_BYTES, JSON_BODY_MAX_DEPTH } from '@/lib/body-limits';

// API が返す利用者向けの日本語メッセージ (内部詳細は含めない)
export const API_MESSAGES = {
  unauthorized: '認証が必要です。Authorization: Bearer <トークン> を付けてください。',
  invalidToken: 'トークンが無効です (失効・期限切れ・ユーザー無効化を含む)。',
  forbidden: 'この操作を行う権限がありません。',
  tenantScopeRequired: 'この操作はテナントのユーザーとして認証したときだけ行えます。',
  platformAdminRequired: 'この操作はプラットフォーム管理者だけが行えます。',
  notFound: '見つかりません。',
  validation: '入力内容に誤りがあります。',
  invalidResourceId: 'id の形式が不正です。',
  controlCharacters: '制御文字は使用できません。',
  loneSurrogate: '文字として解釈できない文字が含まれています。',
  emptyPatch: '変更する項目を 1 つ以上指定してください。',
  duplicate: '既に同じ値が存在します。',
  invalidJson: 'リクエスト本文を JSON として解釈できません。',
  bodyIncomplete: 'リクエスト本文を最後まで受け取れませんでした。',
  unsupportedMediaType: 'Content-Type は application/json にしてください。',
  payloadTooLarge: 'リクエスト本文が大きすぎます。',
  lastAdmin: '最後の有効な管理者の役割変更・無効化はできません。',
  selfDisable: '自分自身を無効化することはできません。',
  userDisabled: 'このユーザーは無効化されています。',
  agentHasHistory:
    '利用・評価・インシデントの履歴があるエージェントは削除できません。停止 (stop) を使ってください。',
  agentNotInTenant: '指定したエージェントが見つかりません。',
  apiKeyRequired: 'このエンドポイントは API キー (aop_k_...) で呼び出してください。',
  apiKeyNotBoundToAgent:
    'この API キーはエージェントに紐づいていません。エージェントを指定して発行したキーを使ってください。',
  agentNotActive: 'このエージェントは停止中です。復帰させてから呼び出してください。',
  // **範囲の数値は定数から埋める。** 書き写すと、定数を動かしたときに文言だけが古くなり、
  // 利用者は「通る値を弾かれた」と読む（§6 の一元管理。入力検証・DB の CHECK・判定の 3 か所が
  // 同じ定数を読んでいるのに、4 か所目の文言だけが写しだった）
  guardrailThresholdOutOfRange: `しきい値が種別ごとの範囲外です (コストは 0 以上の整数、エラー率と品質は 0 以上 ${RATIO_MAX} 以下)。`,
  guardrailWindowOutOfRange: `集計窓は ${GUARDRAIL_WINDOW_MIN_MINUTES} 分以上 ${GUARDRAIL_WINDOW_MAX_MINUTES} 分以内の整数で指定してください。`,
  guardrailRuleLimit:
    'ガードレールのルール数が上限に達しています。不要なルールを削除してください。',
  guardrailRuleRowLimit: `ガードレールのルールの総数 (無効化したものを含む) が上限 ${GUARDRAIL_RULE_ROWS_MAX_PER_TENANT} 件に達しています。不要なルールを削除してください。`,
  guardrailRunPartiallyFailed:
    '一部のルールを判定できませんでした。時間をおいてやり直してください (発火したぶんは記録されています)。',
  guardrailRuleHasIncidents:
    '発火記録があるルールは削除できません (記録からルールを辿れなくなるため)。',
  incidentAlreadyResolved: 'このインシデントは既に解決済みです。',
  rateLimited: '要求が多すぎます。Retry-After 秒だけ待ってからやり直してください。',
  budgetExceeded:
    'このエージェントの予算 (当月) を超えました。予算を見直すか、翌月まで待ってから呼び出してください。',
  unsupportedModel:
    '料金表に無いモデルです。対応モデルを指定してください (計測できない呼び出しは中継しません)。',
  streamingNotSupported: 'ストリーミング (stream: true) には未対応です。',
  // 入れ子が深すぎる本文。**サイズだけでは資源の消費を縛れない** (理由は body-limits.ts)
  bodyTooDeep: `本文の入れ子が深すぎます (上限 ${JSON_BODY_MAX_DEPTH} 段)。ネストを浅くして再試行してください。`,
  upstreamFailure: '上流の LLM プロバイダへの呼び出しに失敗しました。',
  upstreamRateLimited: '上流の LLM プロバイダが混雑しています。時間をおいて再試行してください。',
  upstreamTimeout: '上流の LLM プロバイダが時間内に応答しませんでした。',
  upstreamNotConfigured: 'このプロバイダへの中継は設定されていません。',
  // 上流が要求を拒否したときの定型文。**上流の文章はそのまま返さない** — 自由記述の message には
  // 残高不足・組織名・契約ティアといったプラットフォーム側のアカウント状態が載るため (ADR-0007 決定 7)
  upstreamRejected:
    '上流の LLM プロバイダが要求を受け付けませんでした。error.type / error.code を参照してください。',
  invalidUsageDay: '日付は YYYY-MM-DD で指定してください。',
  reversedUsageRange: 'from は to 以前の日付を指定してください。',
  usageRangeTooLong: `期間は最大 ${USAGE_RANGE_MAX_DAYS} 日までです。`,
  invalidLimit: 'limit は 10 進の整数で指定してください。',
  invalidDecimalInteger: '10 進の整数で指定してください。',
  invalidCursor: 'cursor の形式が不正です。前の応答の nextCursor をそのまま指定してください。',
  microUsdOutOfRange: `0 以上 ${MICRO_USD_MAX.toString()} 以下の整数を文字列で指定してください。`,
  evaluationSetEmpty: '評価ケースを 1 件以上指定してください。',
  evaluationSetTooLarge: `評価ケースは最大 ${EVALUATION_SET_MAX_CASES} 件までです。`,
  judgeNotConfigured: '採点用モデルの設定が正しくありません。',
  // 監査ログの鍵が未設定・短すぎるとき。**何が足りないかは外へ出さない** (§9 の「内部詳細を漏らさない」)。
  // 503 にするのは「設定が無いので今はできない」側の事情だから (上流未設定と同じ扱い)
  auditNotConfigured: '監査ログの設定が正しくありません。',
  // 連鎖の検証の fromSeq が 10 進の整数でない・1 未満のとき (422)
  auditFromSeqInvalid: 'fromSeq は 1 以上の整数を指定してください。',
  auditFromSeqBeyondEnd:
    'fromSeq が監査ログの末尾を越えています (その連番以降に行がありません)。nextFromSeq を渡し直すか、省略して先頭から検証してください。',
  // **連鎖が壊れていたときの文言は置いていない。** `GET /audit-logs/verify` は壊れていても
  // 200 ＋ `{ ok: false, reason, brokenSeq }` を返す設計（壊れたことは隠さないが、
  // 「検証できた」という操作そのものは成功しているのでエラーにしない）。文言を置くと
  // 「壊れたらこのメッセージが返る」と読めてしまい、実装と食い違う
  internal: 'サーバー内部でエラーが発生しました。',
} as const;

// 保存を禁じる Cache-Control の値。route() が全応答に付けるのと、route() を通らない /health が
// 自分で付けるのとで同じ値を使うため、ここを唯一の参照元にする
export const NO_STORE_CACHE_CONTROL = 'no-store';
