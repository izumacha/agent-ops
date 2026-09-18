// UI 文言と enum ラベルの一元管理 (§6)。画面・API のエラー文言はここから引く
import { MICRO_USD_MAX } from '@/domain/money';
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
// JSON 本文の上限 (バイト)。Step1 の入力は短い文字列だけなので小さく保つ (§9 リクエストサイズ上限)
export const JSON_BODY_MAX_BYTES = 64 * 1024;

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
  invalidLimit: 'limit は 10 進の整数で指定してください。',
  invalidDecimalInteger: '10 進の整数で指定してください。',
  invalidCursor: 'cursor の形式が不正です。前の応答の nextCursor をそのまま指定してください。',
  microUsdOutOfRange: `0 以上 ${MICRO_USD_MAX.toString()} 以下の整数を文字列で指定してください。`,
  internal: 'サーバー内部でエラーが発生しました。',
} as const;

// 保存を禁じる Cache-Control の値。route() が全応答に付けるのと、route() を通らない /health が
// 自分で付けるのとで同じ値を使うため、ここを唯一の参照元にする
export const NO_STORE_CACHE_CONTROL = 'no-store';
