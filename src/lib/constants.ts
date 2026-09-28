// UI 文言と enum ラベルの一元管理 (§6)。画面・API のエラー文言はここから引く
import { MICRO_USD_MAX } from '@/domain/money';
import { JSON_BODY_MAX_DEPTH } from '@/lib/body-limits';
import { AgentStatus, Role } from '@/domain/types';

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
// テナント作成時に最初の admin へ発行するログイントークンの用途名 (UserToken.name に保存され一覧に出る)
export const USER_TOKEN_BOOTSTRAP_NAME = '初期管理者トークン';
// 開発用 CLI (scripts/issue-user-token.ts) が発行するトークンの既定の用途名 (--name 省略時)
export const USER_TOKEN_CLI_NAME = 'CLI';
// 日次集計で一度に指定できる期間の上限 (日)。無制限の期間は全件走査になるので必ず区切る (§8 / §9)。
// 366 日 (うるう年を含む 1 年) は「昨年分をまとめて出す」という実際の使い方を 1 回で満たせる最小の値
export const USAGE_RANGE_MAX_DAYS = 366;
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
  internal: 'サーバー内部でエラーが発生しました。',
} as const;

// 保存を禁じる Cache-Control の値。route() が全応答に付けるのと、route() を通らない /health が
// 自分で付けるのとで同じ値を使うため、ここを唯一の参照元にする
export const NO_STORE_CACHE_CONTROL = 'no-store';
