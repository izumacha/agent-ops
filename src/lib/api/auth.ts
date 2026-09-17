// Bearer 認証: Authorization ヘッダのトークンを照合して「誰か」(Principal) を決める (ADR-0005)。
// 2 種類のトークンを受け付ける:
//   - ユーザートークン (aop_u_...): DB のハッシュと照合し、テナント内のユーザーとして振る舞う
//   - プラットフォーム管理者トークン (環境変数 PLATFORM_ADMIN_TOKEN): テナントの外側。テナント作成・列挙だけに使う
import type { Repositories, UserRecord } from '@/data';
import { API_MESSAGES, PLATFORM_ADMIN_TOKEN_MIN_LENGTH } from '@/lib/constants';
import { hashSecret, isUserToken, secretsEqual } from '@/lib/tokens';
import { ApiError } from './errors';
import { HTTP_STATUS } from './http-status';

// テナント内のユーザーとして認証された主体
export interface UserPrincipal {
  kind: 'user';
  // 認証されたユーザー
  user: UserRecord;
  // そのユーザーのテナント (全クエリの where に入れる)
  tenantId: string;
  // 使われたトークンの id
  tokenId: string;
}

// プラットフォーム管理者として認証された主体
export interface PlatformPrincipal {
  kind: 'platform';
}

// 認証された主体
export type Principal = UserPrincipal | PlatformPrincipal;

// Authorization ヘッダの認証方式
const BEARER_SCHEME = 'bearer';
// 短すぎる PLATFORM_ADMIN_TOKEN の警告を出したか (設定ミスは 1 度だけ知らせる。
// 毎リクエストで出すと、未認証の総当たりでエラーログを埋められる)
let warnedShortPlatformToken = false;

// Authorization ヘッダから Bearer トークンを取り出す (無ければ 401)
function extractBearerToken(request: Request): string {
  // ヘッダを読む
  const header = request.headers.get('authorization');
  // 無ければ認証情報無し
  if (!header) throw new ApiError(HTTP_STATUS.UNAUTHORIZED, API_MESSAGES.unauthorized);
  // 方式とトークンに分ける (方式名は大文字小文字を区別しない)
  const [scheme, token, ...rest] = header.trim().split(/\s+/);
  // Bearer 以外・トークン無し・余分な語があれば 401
  if (scheme?.toLowerCase() !== BEARER_SCHEME || !token || rest.length > 0) {
    throw new ApiError(HTTP_STATUS.UNAUTHORIZED, API_MESSAGES.unauthorized);
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
  if (!found) throw new ApiError(HTTP_STATUS.UNAUTHORIZED, API_MESSAGES.invalidToken);
  // 失効済み・期限切れ・ユーザー無効化はすべて同じ 401 (どれかを区別して返すとトークンの状態が漏れる)
  const { token: record, user } = found;
  if (record.revokedAt !== null || record.expiresAt <= now || user.disabledAt !== null) {
    throw new ApiError(HTTP_STATUS.UNAUTHORIZED, API_MESSAGES.invalidToken);
  }
  // テナント内のユーザーとして認証成功
  return { kind: 'user', user, tenantId: user.tenantId, tokenId: record.id };
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
  // 接頭辞で照合経路を振り分ける
  if (isUserToken(token)) return authenticateUserToken(token, repos, now);
  // ユーザートークンの形でなければプラットフォーム管理者トークンとして照合する
  if (matchesPlatformAdminToken(token)) return { kind: 'platform' };
  // どちらでもなければ無効
  throw new ApiError(HTTP_STATUS.UNAUTHORIZED, API_MESSAGES.invalidToken);
}
