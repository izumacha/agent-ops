// 上流 (Anthropic / OpenAI) への中継。**接続先はコードと環境変数だけから決める**のが最重要の約束で、
// クライアントの本文・ヘッダ・パスは接続先に一切影響しない (§9 の SSRF 対策)。
//
// 転送するヘッダはここで組み立てる**だけ**にする (クライアントのヘッダは 1 つも通さない)。
// 素通しにすると、クライアントが送った Authorization が上流へ届いたり、上流向けの資格情報を
// 上書きされたりする。必要になったヘッダ (anthropic-beta など) はここへ明示的に足す。
import { Provider } from '@/domain/types';
import { API_MESSAGES, UPSTREAM_MAX_RESPONSE_BYTES, UPSTREAM_TIMEOUT_MS } from '@/lib/constants';
import { ApiError } from '@/lib/api/errors';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { readStreamWithinByteLimit } from '@/lib/stream-bytes';

// 1 プロバイダ分の結線 (既定の接続先・上書き用の環境変数名・資格情報の環境変数名・叩くパス)
interface UpstreamConfig {
  // 環境変数が無いときに使う公式の接続先
  defaultBaseUrl: string;
  // 接続先を差し替える環境変数名 (ローカルのスタブ上流や社内ゲートウェイを指すために使う)
  baseUrlEnv: string;
  // 上流の資格情報を持つ環境変数名 (クライアントからは決して受け取らない)
  apiKeyEnv: string;
  // 中継先のパス (クライアントの URL とは無関係に、ここで固定する)
  path: string;
}

// Anthropic が要求する API バージョンヘッダの値 (日付版。上流の仕様で固定)
const ANTHROPIC_VERSION = '2023-06-01';

// プロバイダごとの結線表 (**接続先の唯一の定義**)
const UPSTREAMS: Readonly<Record<Provider, UpstreamConfig>> = {
  // Anthropic Messages API
  [Provider.anthropic]: {
    defaultBaseUrl: 'https://api.anthropic.com',
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    path: '/v1/messages',
  },
  // OpenAI Chat Completions API
  [Provider.openai]: {
    defaultBaseUrl: 'https://api.openai.com',
    baseUrlEnv: 'OPENAI_BASE_URL',
    apiKeyEnv: 'OPENAI_API_KEY',
    path: '/v1/chat/completions',
  },
};

// ループバック (自分自身) を指すホスト名。**非本番でだけ** http を許す相手
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

// 中継が設定されていない・設定が安全でないときの例外 (利用者には理由の詳細を出さない)
function notConfiguredError(): ApiError {
  // 503: 今はこの中継を行えない
  return new ApiError(HTTP_STATUS.SERVICE_UNAVAILABLE, API_MESSAGES.upstreamNotConfigured);
}

/**
 * 接続先の基底 URL を決める。環境変数が無ければ公式の接続先。
 * 受け付けるのは「https」か「非本番のループバック http」だけで、資格情報付き URL・クエリ・
 * フラグメント付きは拒否する (設定ミスで平文の別ホストへ資格情報ごと送らないため)。
 */
export function resolveUpstreamBaseUrl(provider: Provider, env: NodeJS.ProcessEnv): URL {
  // そのプロバイダの結線
  const config = UPSTREAMS[provider];
  // 環境変数の指定 (無ければ公式)
  const raw = env[config.baseUrlEnv]?.trim();
  // 指定が空文字なら「未設定」と同じ扱いにする (空の環境変数で公式へ向くほうが安全側)
  const candidate = raw === undefined || raw === '' ? config.defaultBaseUrl : raw;
  // URL として読めること
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    // 読めない値は設定ミス
    throw notConfiguredError();
  }
  // 資格情報付き URL (user:pass@host) は拒否する (ログや Referer に漏れる形)
  if (url.username !== '' || url.password !== '') throw notConfiguredError();
  // クエリ・フラグメント付きの基底 URL は、パスを足すと意味が変わるので拒否する
  if (url.search !== '' || url.hash !== '') throw notConfiguredError();
  // https ならそのまま使える
  if (url.protocol === 'https:') return url;
  // http はローカルのスタブ上流に限る。本番では平文の中継を許さない (資格情報が素で流れる)
  const loopback = LOOPBACK_HOSTS.has(url.hostname) || LOOPBACK_HOSTS.has(`[${url.hostname}]`);
  if (url.protocol === 'http:' && loopback && env.NODE_ENV !== 'production') return url;
  // それ以外は拒否 (fail-closed)
  throw notConfiguredError();
}

/** 中継先の完全な URL (基底 + プロバイダごとの固定パス)。クライアントの URL は使わない */
export function upstreamEndpoint(provider: Provider, env: NodeJS.ProcessEnv): URL {
  // 基底 URL を決める
  const base = resolveUpstreamBaseUrl(provider, env);
  // 基底のパスの末尾スラッシュを整えてから固定パスを足す
  const path = `${base.pathname.replace(/\/+$/, '')}${UPSTREAMS[provider].path}`;
  // **必ず基底の origin へ繋ぐ**。`new URL(path, base)` で組み立てると、基底のパスが `//` で始まるとき
  // (`https://api.anthropic.com//evil.example.com` のような末尾スラッシュの打ち間違い) その部分が
  // プロトコル相対 URL として解釈され、**別ホストへ上流の API キーごと送られる** (実測)。
  // origin を前に置いて組み立てれば、パスがどう書かれていても接続先のホストは動かない
  return new URL(`${base.origin}${path}`);
}

/** 中継に必要な材料 (接続先と上流の資格情報)。どちらも環境変数とコードだけから決まる */
export interface UpstreamTarget {
  // 中継先の URL
  endpoint: URL;
  // 上流の資格情報 (クライアントからは決して受け取らない)
  apiKey: string;
}

/**
 * 中継先と資格情報を決める。設定が無い・安全でなければ 503 を投げる。
 * **呼び出し側は「上流を叩く前」にこれを呼ぶ** — 到達すらしなかった呼び出しを
 * 利用イベントとして記録しないため (記録するのは実際に上流へ出た呼び出しだけ。ADR-0007)
 */
export function resolveUpstreamTarget(provider: Provider, env = process.env): UpstreamTarget {
  // 中継先 (設定が安全でなければここで 503)
  const endpoint = upstreamEndpoint(provider, env);
  // 上流の資格情報 (未設定なら中継できない)
  const apiKey = env[UPSTREAMS[provider].apiKeyEnv]?.trim();
  if (apiKey === undefined || apiKey === '') throw notConfiguredError();
  // 中継の材料
  return { endpoint, apiKey };
}

/** 上流へ送るヘッダを組み立てる (クライアントのヘッダは 1 つも含めない) */
function upstreamHeaders(provider: Provider, apiKey: string): Headers {
  // JSON を送る
  const headers = new Headers({ 'content-type': 'application/json' });
  // プロバイダごとの資格情報の載せ方
  if (provider === Provider.anthropic) {
    // Anthropic は x-api-key とバージョンヘッダ
    headers.set('x-api-key', apiKey);
    headers.set('anthropic-version', ANTHROPIC_VERSION);
  } else {
    // OpenAI は Bearer
    headers.set('authorization', `Bearer ${apiKey}`);
  }
  // 組み立てたヘッダ
  return headers;
}

// 中継の結果 (上流の応答)。**かかった時間はここでは持たない** —
// 記録する latencyMs は「時間切れや接続不能で応答が無かったとき」も要るので、呼び出し側が
// 成功・失敗の両方を含む 1 か所で測る (2 か所で測ると定義が割れる)
export interface UpstreamResult {
  // 上流の HTTP ステータス
  status: number;
  // 上流の応答本文 (文字列のまま。解釈は呼び出し側)
  body: string;
  // 上流が返した Retry-After (無ければ null)。混雑時の待ち時間だけは中継しても
  // プラットフォーム側の情報を漏らさないので、呼び出し側がクライアントへ渡せるようにする
  retryAfter: string | null;
}

// 中継の入力
export interface UpstreamCall {
  // どのプロバイダへ送るか
  provider: Provider;
  // 中継先と資格情報 (resolveUpstreamTarget で先に決めたもの)
  target: UpstreamTarget;
  // 送る本文 (検証済みの JSON 文字列)
  body: string;
  // 応答を待つ上限 (ミリ秒)
  timeoutMs?: number;
  // 応答本文を読む上限 (バイト)
  maxResponseBytes?: number;
}

/**
 * 上流を呼ぶ。応答が返れば (4xx / 5xx でも) UpstreamResult として返し、
 * 時間切れは 504、接続できないなどの失敗は 502 の ApiError にする。
 * **上流の失敗の詳細は利用者へ返さない** (サーバログに残すのは呼び出し側の責務)。
 */
export async function callUpstream(call: UpstreamCall): Promise<UpstreamResult> {
  // 待ち時間の上限
  const timeoutMs = call.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  // 応答本文の上限
  const maxResponseBytes = call.maxResponseBytes ?? UPSTREAM_MAX_RESPONSE_BYTES;
  // 上流を呼ぶ
  try {
    // 上限時間で打ち切る (リダイレクトは追わない — 追うと接続先の allowlist を上流が書き換えられる)
    const response = await fetch(call.target.endpoint, {
      method: 'POST',
      headers: upstreamHeaders(call.provider, call.target.apiKey),
      body: call.body,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 応答本文を**上限バイトまで**読む。response.text() は全量をメモリへ載せてからしか大きさが
    // 分からないので、壊れた前段ゲートウェイが巨大な本文を返すとそのぶんヒープを握ってしまう
    // **上限を超えたら下層も解放する** (cancelOnOverflow) — 読むのをやめるだけだと応答ボディが
    // 未消費のまま残り、ソケットと fd がタイムアウトまで解放されない (実測)。
    // リクエスト本文側と事情が逆なので、共有ヘルパーではこちらが明示的に選ぶ
    const read = await readStreamWithinByteLimit(response.body, maxResponseBytes, {
      cancelOnOverflow: true,
    });
    // 上限超過・UTF-8 として壊れた本文は「上流の応答が使えなかった」として 502 にする
    // (中途半端に切り詰めた本文を JSON として解釈させない)
    if (!read.ok) throw new ApiError(HTTP_STATUS.BAD_GATEWAY, API_MESSAGES.upstreamFailure);
    // ステータス・本文・待ち時間の指示を返す
    return {
      status: response.status,
      body: read.text,
      retryAfter: response.headers.get('retry-after'),
    };
  } catch (error) {
    // 上で組み立てた ApiError (本文が大きすぎる等) はそのまま上げる
    if (error instanceof ApiError) throw error;
    // 時間切れは 504 (上流が応答しなかった)
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new ApiError(HTTP_STATUS.GATEWAY_TIMEOUT, API_MESSAGES.upstreamTimeout);
    }
    // それ以外 (接続不能・リダイレクト・切断) は 502。内部の詳細は返さない
    throw new ApiError(HTTP_STATUS.BAD_GATEWAY, API_MESSAGES.upstreamFailure);
  }
}
