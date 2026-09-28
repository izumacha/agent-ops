// Bearer 認証: Authorization ヘッダのトークンを照合して「誰か」(Principal) を決める (ADR-0005)。
// 3 種類の資格情報があり、**経路ごとに受け付ける種類を分ける**:
//   - ユーザートークン (aop_u_...): DB のハッシュと照合し、テナント内のユーザーとして振る舞う (v1 の API)
//   - プラットフォーム管理者トークン (環境変数 PLATFORM_ADMIN_TOKEN): テナントの外側。テナント作成・列挙だけに使う
//   - API キー (aop_k_...): **プロキシ専用** (Step2)。エージェントとして振る舞う
// 混ぜないのが要点で、authenticate() は API キーを受け付けず、authenticateApiKey() はユーザートークンを
// 受け付けない。混ぜると「エージェント用の資格情報でユーザー向け API が叩ける」形に育つ
import type { AgentRecord, Repositories, UserRecord } from '@/data';
import { AgentStatus } from '@/domain/types';
import { API_MESSAGES, PLATFORM_ADMIN_TOKEN_MIN_LENGTH } from '@/lib/constants';
import { hashSecret, isApiKey, isUserToken, secretsEqual } from '@/lib/tokens';
import { ApiError } from './errors';
import { HTTP_STATUS } from './http-status';

// テナント内のユーザーとして認証された主体
export interface UserPrincipal {
  kind: 'user';
  // 認証されたユーザー
  user: UserRecord;
  // そのユーザーのテナント (全クエリの where に入れる)
  tenantId: string;
}

// プラットフォーム管理者として認証された主体
export interface PlatformPrincipal {
  kind: 'platform';
}

// API キーで認証された主体 (プロキシ経路だけに現れる)
export interface AgentPrincipal {
  kind: 'agent';
  // 呼び出し元のエージェント (状態は認証時に active であることを確かめている)
  agent: AgentRecord;
  // そのエージェントのテナント (記録・集計の where に入れる)
  tenantId: string;
  // 使われた API キーの id (監査・失効の追跡用。平文もハッシュも持ち回らない)
  apiKeyId: string;
}

// 認証された主体
export type Principal = UserPrincipal | PlatformPrincipal | AgentPrincipal;

// Authorization ヘッダの認証方式
const BEARER_SCHEME = 'bearer';
// 401 に付ける WWW-Authenticate ヘッダ (RFC 6750 §3。方式の発見と「資格情報無し / 無効」の区別に使う)
const WWW_AUTHENTICATE_HEADER = 'WWW-Authenticate';
const CHALLENGE_MISSING = 'Bearer realm="agent-ops"';
const CHALLENGE_INVALID = 'Bearer realm="agent-ops", error="invalid_token"';

// 401 (資格情報が無い) の例外
function unauthorizedError(): ApiError {
  // 方式だけを示すチャレンジを付ける
  return new ApiError(HTTP_STATUS.UNAUTHORIZED, API_MESSAGES.unauthorized, undefined, {
    [WWW_AUTHENTICATE_HEADER]: CHALLENGE_MISSING,
  });
}

// 401 (資格情報が無効) の例外。無効の理由 (失効・期限切れ・無効化) は区別しない
function invalidTokenError(): ApiError {
  // invalid_token のチャレンジを付ける
  return new ApiError(HTTP_STATUS.UNAUTHORIZED, API_MESSAGES.invalidToken, undefined, {
    [WWW_AUTHENTICATE_HEADER]: CHALLENGE_INVALID,
  });
}
// 短すぎる PLATFORM_ADMIN_TOKEN の警告を出したか (設定ミスは 1 度だけ知らせる。
// 毎リクエストで出すと、未認証の総当たりでエラーログを埋められる)
let warnedShortPlatformToken = false;

// Authorization ヘッダから Bearer トークンを取り出す (無ければ 401)
function extractBearerToken(request: Request): string {
  // ヘッダを読む
  const header = request.headers.get('authorization');
  // 無ければ認証情報無し
  if (!header) throw unauthorizedError();
  // 方式とトークンに分ける (方式名は大文字小文字を区別しない)
  const [scheme, token, ...rest] = header.trim().split(/\s+/);
  // Bearer 以外・トークン無し・余分な語があれば 401
  if (scheme?.toLowerCase() !== BEARER_SCHEME || !token || rest.length > 0) {
    throw unauthorizedError();
  }
  // トークン本体
  return token;
}

// 環境変数のプラットフォーム管理者トークンと照合する (未設定・短すぎは常に不一致 = fail-closed)
function matchesPlatformAdminToken(token: string): boolean {
  // 環境変数を読む
  const configured = process.env.PLATFORM_ADMIN_TOKEN;
  // 未設定ならプラットフォーム管理者は存在しない
  if (!configured) return false;
  // 短すぎる値は設定ミスとみなし、使わない (弱いトークンで全テナントを作れる状態を作らない)
  if (configured.length < PLATFORM_ADMIN_TOKEN_MIN_LENGTH) {
    // 設定ミスの警告は初回だけ出す
    if (!warnedShortPlatformToken) {
      warnedShortPlatformToken = true;
      console.error(
        `[auth] PLATFORM_ADMIN_TOKEN が短すぎます (${PLATFORM_ADMIN_TOKEN_MIN_LENGTH} 文字以上が必要)。無視します。`,
      );
    }
    return false;
  }
  // 定数時間で比較する
  return secretsEqual(token, configured);
}

// ユーザートークンを照合し、有効ならユーザー主体を返す
async function authenticateUserToken(
  token: string,
  repos: Repositories,
  now: Date,
): Promise<UserPrincipal> {
  // 平文は保存していないので、ハッシュで引く
  const found = await repos.userTokens.findByHash(hashSecret(token));
  // 無ければ無効
  if (!found) throw invalidTokenError();
  // 失効済み・期限切れ・ユーザー無効化はすべて同じ 401 (どれかを区別して返すとトークンの状態が漏れる)
  const { token: record, user } = found;
  if (record.revokedAt !== null || record.expiresAt <= now || user.disabledAt !== null) {
    throw invalidTokenError();
  }
  // テナント内のユーザーとして認証成功
  return { kind: 'user', user, tenantId: user.tenantId };
}

// API キーを照合し、有効ならエージェント主体を返す
async function authenticateApiKeySecret(
  secret: string,
  repos: Repositories,
): Promise<AgentPrincipal> {
  // 平文は保存していないので、ハッシュで引く (テナントを跨いで検索する唯一の経路)
  const found = await repos.apiKeys.findByHash(hashSecret(secret));
  // 無ければ無効
  if (!found) throw invalidTokenError();
  // 失効済みのキーは無効 (存在しないキーと同じ 401。どちらかを区別して返すと状態が漏れる)
  if (found.key.revokedAt !== null) throw invalidTokenError();
  // テナント共通キー (エージェント未指定) では利用イベントを記録できないので中継しない。
  // 資格情報としては有効なので 401 ではなく 403 (「誰か」は決まったが、この操作には使えない)
  if (found.agent === null) {
    throw new ApiError(HTTP_STATUS.FORBIDDEN, API_MESSAGES.apiKeyNotBoundToAgent);
  }
  // 停止中・自動停止中のエージェントは中継しない (Step4 の自動停止が実際に呼び出しを止める経路)
  if (found.agent.status !== AgentStatus.active) {
    throw new ApiError(HTTP_STATUS.FORBIDDEN, API_MESSAGES.agentNotActive);
  }
  // エージェントとして認証成功
  return {
    kind: 'agent',
    agent: found.agent,
    tenantId: found.agent.tenantId,
    apiKeyId: found.key.id,
  };
}

/**
 * プロキシ経路の認証。**API キー (aop_k_...) だけ**を受け付ける。
 * ユーザートークンやプラットフォーム管理者トークンは、正しい資格情報でもここでは 401 にする
 * (中継は必ずエージェント単位で記録するため、「誰のエージェントか」が決まらない資格情報は使えない)。
 */
export async function authenticateApiKey(
  request: Request,
  repos: Repositories,
): Promise<Principal> {
  // Bearer トークンを取り出す
  const secret = extractBearerToken(request);
  // API キーの形でなければ、DB を引かずに無効とする
  if (!isApiKey(secret)) throw invalidTokenError();
  // ハッシュで照合する
  return authenticateApiKeySecret(secret, repos);
}

/**
 * リクエストを認証して主体を返す。失敗はすべて 401 の ApiError。
 * now は期限判定の基準時刻 (テストで固定できるよう引数にしている)
 */
export async function authenticate(
  request: Request,
  repos: Repositories,
  now: Date = new Date(),
): Promise<Principal> {
  // Bearer トークンを取り出す
  const token = extractBearerToken(request);
  // まずプラットフォーム管理者トークンと照合する (DB を触らない定数時間比較なので先に置ける。
  // 後に置くと、運用者が aop_u_ で始まる値を設定したときユーザートークンの経路へ吸われて永遠に一致しない)
  if (matchesPlatformAdminToken(token)) return { kind: 'platform' };
  // ユーザートークンの形なら DB のハッシュと照合する
  if (isUserToken(token)) return authenticateUserToken(token, repos, now);
  // どちらでもなければ無効。**API キー (aop_k_) もここへ落ちる** — プロキシ専用なので、
  // 有効なキーであっても v1 の API では無効として扱う (経路を混ぜない。ADR-0007)
  throw invalidTokenError();
}
