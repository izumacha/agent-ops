// API テスト共通のヘルパー: memory アダプタへ差し替え、2 テナント分のユーザーとトークンを seed し、
// Route Handler を HTTP を介さずに直接呼ぶ (本番と同じ認証・認可・検証の経路を通す)
import { setReposForTesting } from '@/data';
import { createMemoryRepos, type MemoryStore } from '@/data/adapters/memory';
import type { AgentRecord, UserRecord, UserTokenRecord } from '@/data';
import { AgentStatus, Plan, Provider, Role } from '@/domain/types';
import type { RouteContext } from '@/lib/api/handler';
import { issueUserToken } from '@/lib/tokens';

// テストで使うプラットフォーム管理者トークン (32 文字以上)
export const PLATFORM_TOKEN = 'test-platform-admin-token-0123456789abcdef';
// seed するトークンの有効期間 (日)
const SEED_TOKEN_TTL_DAYS = 30;

// seed したテナント 1 つ分の情報
export interface SeededTenant {
  id: string;
  // 役割ごとのユーザー
  users: Record<Role, UserRecord>;
  // 役割ごとのログイントークン (平文)
  tokens: Record<Role, string>;
  // 役割ごとのトークン行
  tokenRows: Record<Role, UserTokenRecord>;
  // 最初から登録されているエージェント
  agent: AgentRecord;
}

// seed 全体
export interface Seed {
  store: MemoryStore;
  a: SeededTenant;
  b: SeededTenant;
}

// テナント 1 つ分を表へ入れる
function seedTenant(store: MemoryStore, label: string): SeededTenant {
  // 作成時刻
  const now = store.now();
  // テナント行
  const id = store.nextId('tenant');
  store.tenants.set(id, {
    id,
    name: `テナント${label}`,
    plan: Plan.free,
    createdAt: now,
    updatedAt: now,
  });
  // 役割ごとにユーザーとトークンを作る
  const users = {} as Record<Role, UserRecord>;
  const tokens = {} as Record<Role, string>;
  const tokenRows = {} as Record<Role, UserTokenRecord>;
  for (const role of Object.values(Role)) {
    // ユーザー行 (実在しないドメインのアドレス)
    const user: UserRecord = {
      id: store.nextId('user'),
      tenantId: id,
      // 保存されるメールは小文字に正規化された形 (API の入力と同じ規則)
      email: `${role}-${label.toLowerCase()}@example.com`,
      name: `${role} ${label}`,
      role,
      disabledAt: null,
      createdAt: now,
      updatedAt: now,
    };
    store.users.set(user.id, user);
    // 平文トークンとそのハッシュ行
    const issued = issueUserToken('テスト用', SEED_TOKEN_TTL_DAYS, now);
    const token: UserTokenRecord = {
      id: store.nextId('utok'),
      tenantId: id,
      userId: user.id,
      ...issued.input,
      createdAt: now,
      revokedAt: null,
    };
    store.userTokens.set(token.id, token);
    // 束ねる
    users[role] = user;
    tokens[role] = issued.secret;
    tokenRows[role] = token;
  }
  // 最初から 1 件あるエージェント
  const agent: AgentRecord = {
    id: store.nextId('agent'),
    tenantId: id,
    name: `既存エージェント${label}`,
    description: null,
    provider: Provider.anthropic,
    model: 'claude-sonnet-4-6',
    status: AgentStatus.active,
    budgetMicroUsd: null,
    createdAt: now,
    updatedAt: now,
  };
  store.agents.set(agent.id, agent);
  // まとめて返す
  return { id, users, tokens, tokenRows, agent };
}

// setupSeed 前の環境変数 (teardownSeed で戻す)
let platformTokenBefore: string | undefined;

// memory アダプタへ差し替え、テナント A / B を seed する (各テストの beforeEach で呼ぶ。afterEach で teardownSeed を対にする)
export function setupSeed(): Seed {
  // 新しい表で memory アダプタを作る
  const repos = createMemoryRepos();
  // Composition Root を差し替える
  setReposForTesting(repos);
  // プラットフォーム管理者トークンを設定する (元の値は後始末で戻す)
  platformTokenBefore = process.env.PLATFORM_ADMIN_TOKEN;
  process.env.PLATFORM_ADMIN_TOKEN = PLATFORM_TOKEN;
  // 2 テナント分を seed する
  return { store: repos.store, a: seedTenant(repos.store, 'A'), b: seedTenant(repos.store, 'B') };
}

// setupSeed の後始末: Composition Root と環境変数を元へ戻す (ファイル単位の隔離に頼らず、別ファイルへ漏らさない)
export function teardownSeed(): void {
  // 本番の束へ戻す
  setReposForTesting(undefined);
  // 環境変数を元の値へ (元が未設定なら消す)
  if (platformTokenBefore === undefined) delete process.env.PLATFORM_ADMIN_TOKEN;
  else process.env.PLATFORM_ADMIN_TOKEN = platformTokenBefore;
}

// Route Handler の関数型 (route() が返す形)
type RouteFn<P> = (request: Request, context: RouteContext<P>) => Promise<Response>;

// 呼び出しの指定
export interface CallOptions<P> {
  method?: string;
  // Bearer トークン (省略時はヘッダ無し)
  token?: string;
  // JSON 本文 (指定時は Content-Type を付ける)
  body?: unknown;
  // 生の本文 (JSON 構文エラー・不正なバイト列・途中で失敗するストリームを試すとき)
  rawBody?: string | Uint8Array | ReadableStream<Uint8Array>;
  // 追加ヘッダ
  headers?: Record<string, string>;
  // 動的セグメント
  params?: P;
  // クエリ文字列 (先頭の ? 無し)
  query?: string;
}

// 呼び出し結果
export interface CallResult {
  status: number;
  // JSON 本文 (204 など本文無しは undefined)
  json: unknown;
  // 応答ヘッダ (WWW-Authenticate などの検査用)
  headers: Headers;
}

// Route Handler を直接呼ぶ (URL はダミー。ハンドラはクエリと本文とヘッダしか見ない)
export async function call<P = Record<string, never>>(
  handler: RouteFn<P>,
  options: CallOptions<P> = {},
): Promise<CallResult> {
  // ヘッダを組み立てる
  const headers = new Headers(options.headers);
  if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  // 本文
  const body =
    options.rawBody !== undefined
      ? options.rawBody
      : options.body !== undefined
        ? JSON.stringify(options.body)
        : undefined;
  // リクエストを作る (本文がストリームのときは fetch 仕様が duplex: 'half' を要求する)
  const request = new Request(
    `http://test.local/api/v1/x${options.query ? `?${options.query}` : ''}`,
    {
      method: options.method ?? (body !== undefined ? 'POST' : 'GET'),
      headers,
      body,
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    } as RequestInit,
  );
  // ハンドラを呼ぶ (params は Next.js 16 と同じく Promise で渡す)
  const response = await handler(request, {
    params: Promise.resolve((options.params ?? {}) as P),
  });
  // 本文を JSON として読む (無ければ undefined)
  const text = await response.text();
  return {
    status: response.status,
    json: text ? JSON.parse(text) : undefined,
    headers: response.headers,
  };
}
