// プロキシ経路 (POST /api/v1/proxy/*) の API テスト。上流 (Anthropic / OpenAI) は fetch を差し替えて模す —
// **実際の API キーも課金も一切発生させない** (CLAUDE.md §11「外部 API はモックして実際には呼ばない」)。
//
// ここで固定するのは 4 つの系統:
//   1. 認証: API キーだけを受け付け、失効キー・テナント共通キー・停止中エージェントは通さない
//   2. 計測: 記録される UsageEvent の中身 (トークン・料金・遅延・ステータス) が上流の応答と一致する
//   3. 中継: クライアントのヘッダを上流へ渡さず、接続先・資格情報はサーバ側の設定だけで決まる
//   4. 失敗: 上流の 5xx・時間切れでも記録を残し、上流の詳細は利用者へ返さない
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RELAYABLE_CLIENT_ERROR_STATUSES,
  UPSTREAM_STATUS_MASKING,
} from '@/app/api/v1/proxy/proxy-route';
import { POST as proxyAnthropic } from '@/app/api/v1/proxy/anthropic/messages/route';
import { POST as proxyOpenAi } from '@/app/api/v1/proxy/openai/chat/completions/route';
import { AgentStatus, Provider } from '@/domain/types';
import { costMicroUsd } from '@/domain/pricing';
import { JSON_BODY_MAX_BYTES } from '@/lib/constants';
import { call, seedApiKey, seedEachTest } from './helpers';

// seed (2 テナント × 3 役割 + 既存エージェント)
const seed = seedEachTest();

// テストで使うモデル (料金表にある値。seed のエージェントと同じ)
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
// OpenAI 側のテスト用モデル
const OPENAI_MODEL = 'gpt-5';
// スタブ上流の接続先 (ループバックなので非本番では http を許す。fetch は差し替えるので実際には繋がない)
const STUB_BASE_URL = 'http://127.0.0.1:4010';

// 本文を持てない HTTP ステータス (RFC 9110)。Response に本文を渡すと TypeError になる
const BODYLESS_STATUSES = new Set([204, 205, 304]);

// 差し替えた fetch が受け取った呼び出し (URL とオプション)
let fetchCalls: { url: string; init: RequestInit }[] = [];

// スタブ上流に用意させる応答。body は JSON 化して返す (rawBody を渡した場合はそのまま返す)
interface StubResponse {
  // 返す HTTP ステータス
  status: number;
  // 返す本文 (JSON 化する)
  body?: unknown;
  // 本文を文字列のまま返したいとき (JSON でない応答を模す)
  rawBody?: string;
  // Content-Type (省略時は application/json)
  contentType?: string;
  // 追加のヘッダ (Retry-After など)
  headers?: Record<string, string>;
  // 応答を返すまでの待ち時間 (ミリ秒。遅延の記録を確かめるときに使う)
  delayMs?: number;
}

// 上流の応答を 1 回分用意する (fetch の差し替え)
function stubUpstream(response: StubResponse | Error): void {
  // 本文を持てないステータスに本文を渡そうとしたら**この場で**落とす。
  // **fake fetch の中で投げてはいけない** — callUpstream の catch-all が同じ 502 に写すので、
  // テストは緑のまま別の経路 (接続の失敗) を測ることになる。これは 204 の検査が空振りしていたときと
  // 投げる主体が変わっただけの同じ形で、実測でもガードの有無で結果が 1 ビットも変わらなかった
  if (
    !(response instanceof Error) &&
    BODYLESS_STATUSES.has(response.status) &&
    (response.body !== undefined || response.rawBody !== undefined)
  ) {
    throw new Error(
      `${response.status} は本文を持てないステータスです (本文を渡すと別の経路を測ることになる)`,
    );
  }
  // fetch の代わりに呼ばれる関数
  const fake = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    // 呼び出しを記録する (URL とヘッダを後で検査する)
    fetchCalls.push({ url: String(input), init: init ?? {} });
    // 例外を模すときはそのまま投げる (時間切れ・接続不能)
    if (response instanceof Error) throw response;
    // 遅延の指定があれば待つ (latencyMs の記録を確かめるため)
    if (response.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, response.delayMs));
    }
    // 返す本文 (rawBody 優先。無ければ body を JSON 化する)。
    // 本文を持てないステータスには null を渡す (undici は空文字でも TypeError で拒否する)
    const body = BODYLESS_STATUSES.has(response.status)
      ? null
      : (response.rawBody ?? JSON.stringify(response.body));
    // 応答を返す
    return new Response(body, {
      status: response.status,
      headers: {
        'content-type': response.contentType ?? 'application/json',
        ...(response.headers ?? {}),
      },
    });
  });
  // グローバルの fetch を差し替える
  vi.stubGlobal('fetch', fake);
}

// Anthropic 形式の正常な応答 (usage を持つ)
function anthropicResponse(inputTokens: number, outputTokens: number): Record<string, unknown> {
  // 上流が返す形のうち、このテストが見る項目だけを持たせる
  return {
    id: 'msg_test',
    content: [{ type: 'text', text: 'こんにちは' }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

// OpenAI 形式の正常な応答
function openAiResponse(promptTokens: number, completionTokens: number): Record<string, unknown> {
  // 項目名が Anthropic と違うことを確かめるために使う
  return {
    id: 'chatcmpl_test',
    choices: [{ message: { role: 'assistant', content: 'hi' } }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  };
}

// 記録された利用イベントを新しい順に取り出す
function recordedEvents() {
  // 表の中身を配列にする
  return [...seed.store.usageEvents.values()];
}

beforeEach(() => {
  // 呼び出しの記録を空にする
  fetchCalls = [];
  // 上流の接続先と資格情報はサーバ側の設定として与える (クライアントからは渡らない)
  vi.stubEnv('ANTHROPIC_BASE_URL', STUB_BASE_URL);
  vi.stubEnv('ANTHROPIC_API_KEY', 'upstream-anthropic-key');
  vi.stubEnv('OPENAI_BASE_URL', STUB_BASE_URL);
  vi.stubEnv('OPENAI_API_KEY', 'upstream-openai-key');
});

afterEach(() => {
  // 差し替えを元へ戻す (別ファイルへ漏らさない)
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('プロキシの認証 (API キー限定)', () => {
  it('エージェントに紐づく有効なキーなら中継する', async () => {
    // 上流は正常応答
    stubUpstream({ status: 200, body: anthropicResponse(100, 50) });
    // エージェントに紐づくキーを発行する
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    // 中継を呼ぶ
    const result = await call(proxyAnthropic, {
      token: key.secret,
      body: { model: ANTHROPIC_MODEL, messages: [] },
    });
    // 上流の応答がそのまま返る
    expect(result.status).toBe(200);
    expect((result.json as { id: string }).id).toBe('msg_test');
  });

  it('失効したキーは 401 (存在しないキーと区別しない)', async () => {
    // 上流は呼ばれない想定だが、呼ばれたことを検出できるよう用意しておく
    stubUpstream({ status: 200, body: anthropicResponse(1, 1) });
    // キーを発行して失効させる
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    await seed.repos.apiKeys.revoke(seed.a.id, key.row.id);
    // 中継を呼ぶ
    const result = await call(proxyAnthropic, {
      token: key.secret,
      body: { model: ANTHROPIC_MODEL },
    });
    // 401 で、上流は呼ばれない
    expect(result.status).toBe(401);
    expect(fetchCalls).toHaveLength(0);
  });

  it('存在しないキーは 401', async () => {
    // 上流は呼ばれない
    stubUpstream({ status: 200, body: anthropicResponse(1, 1) });
    // 形だけ正しいキー
    const result = await call(proxyAnthropic, {
      token: 'aop_k_0123456789abcdef0123456789abcdef',
      body: { model: ANTHROPIC_MODEL },
    });
    // 401
    expect(result.status).toBe(401);
    expect(fetchCalls).toHaveLength(0);
  });

  it('エージェントに紐づかないテナント共通キーは 403 (記録先が決まらない)', async () => {
    // 上流は呼ばれない
    stubUpstream({ status: 200, body: anthropicResponse(1, 1) });
    // agentId が null のキー
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: null });
    // 中継を呼ぶ
    const result = await call(proxyAnthropic, {
      token: key.secret,
      body: { model: ANTHROPIC_MODEL },
    });
    // 403 (資格情報としては有効だが、この操作には使えない)
    expect(result.status).toBe(403);
    expect(fetchCalls).toHaveLength(0);
  });

  it.each([
    ['手動で停止したエージェント', AgentStatus.stopped],
    ['自動停止されたエージェント', AgentStatus.suspended],
  ])('%s のキーは 403 (停止が実際に呼び出しを止める)', async (_label, status) => {
    // 上流は呼ばれない
    stubUpstream({ status: 200, body: anthropicResponse(1, 1) });
    // エージェントを停止する
    await seed.repos.agents.setStatus(seed.a.id, seed.a.agent.id, status);
    // そのエージェントのキー
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    // 中継を呼ぶ
    const result = await call(proxyAnthropic, {
      token: key.secret,
      body: { model: ANTHROPIC_MODEL },
    });
    // 403 で、上流は呼ばれない
    expect(result.status).toBe(403);
    expect(fetchCalls).toHaveLength(0);
  });

  it('他テナントのエージェントのキーでも、そのキーのテナントとして記録される', async () => {
    // 上流は正常応答
    stubUpstream({ status: 200, body: anthropicResponse(10, 20) });
    // テナント B のエージェントのキー
    const key = seedApiKey(seed, { tenantId: seed.b.id, agentId: seed.b.agent.id });
    // 中継を呼ぶ
    await call(proxyAnthropic, { token: key.secret, body: { model: ANTHROPIC_MODEL } });
    // 記録はテナント B のもの (キーのテナントを跨がない)
    expect(recordedEvents()).toHaveLength(1);
    expect(recordedEvents()[0].tenantId).toBe(seed.b.id);
    expect(recordedEvents()[0].agentId).toBe(seed.b.agent.id);
  });
});

describe('中継するヘッダと接続先', () => {
  it('接続先は設定から決まり、クライアントの Authorization は上流へ渡らない', async () => {
    // 上流は正常応答
    stubUpstream({ status: 200, body: anthropicResponse(1, 1) });
    // キーを発行して中継する (独自ヘッダも付けてみる)
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    await call(proxyAnthropic, {
      token: key.secret,
      body: { model: ANTHROPIC_MODEL },
      headers: { 'x-attacker': 'leaked' },
    });
    // 1 回だけ呼ばれ、接続先は設定した値 + 固定パス
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${STUB_BASE_URL}/v1/messages`);
    // 上流へ送ったヘッダ
    const headers = new Headers(fetchCalls[0].init.headers);
    // Anthropic の資格情報はサーバ側の環境変数から
    expect(headers.get('x-api-key')).toBe('upstream-anthropic-key');
    // バージョンヘッダも付く
    expect(headers.get('anthropic-version')).not.toBeNull();
    // クライアントの Authorization (= agent-ops の API キー) は渡さない
    expect(headers.get('authorization')).toBeNull();
    // クライアントの独自ヘッダも渡さない
    expect(headers.get('x-attacker')).toBeNull();
  });

  it('リダイレクトを追わず、時間切れの合図つきで呼ぶ', async () => {
    // **この 2 つは応答の形に現れない**ので、fetch へ渡したオプションそのものを見る。
    // redirect を 'follow' に戻すと上流の 302 で接続先の allowlist を上流側が書き換えられ、
    // signal を外すと応答が来ない上流に対して待ち続ける (どちらも他の検査は全件緑のまま通る)
    stubUpstream({ status: 200, body: anthropicResponse(1, 1) });
    // 中継する
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    await call(proxyAnthropic, { token: key.secret, body: { model: ANTHROPIC_MODEL } });
    // リダイレクトは追わずエラーにする
    expect(fetchCalls[0].init.redirect).toBe('error');
    // 時間切れの合図が渡っている
    expect(fetchCalls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('OpenAI 経路は Bearer で資格情報を渡し、パスも OpenAI のものになる', async () => {
    // 上流は正常応答
    stubUpstream({ status: 200, body: openAiResponse(1, 1) });
    // キーを発行して中継する
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    await call(proxyOpenAi, { token: key.secret, body: { model: OPENAI_MODEL } });
    // 接続先と資格情報
    expect(fetchCalls[0].url).toBe(`${STUB_BASE_URL}/v1/chat/completions`);
    expect(new Headers(fetchCalls[0].init.headers).get('authorization')).toBe(
      'Bearer upstream-openai-key',
    );
  });

  it('上流へ送る本文は検証済みの JSON (未知のパラメータは保ったまま渡す)', async () => {
    // 上流は正常応答
    stubUpstream({ status: 200, body: anthropicResponse(1, 1) });
    // ベンダー独自のパラメータを含む本文
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    await call(proxyAnthropic, {
      token: key.secret,
      body: { model: ANTHROPIC_MODEL, max_tokens: 1024, metadata: { user_id: 'u1' } },
    });
    // 上流が受け取った本文
    const sent = JSON.parse(String(fetchCalls[0].init.body)) as Record<string, unknown>;
    // ベンダーのパラメータは落とさずに渡る
    expect(sent.max_tokens).toBe(1024);
    expect(sent.metadata).toEqual({ user_id: 'u1' });
  });
});

describe('計測 (UsageEvent の記録)', () => {
  it('成功した呼び出しはトークン数と料金を記録する', async () => {
    // 上流は 1234 / 567 トークンを申告する
    stubUpstream({ status: 200, body: anthropicResponse(1234, 567) });
    // 中継する
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    await call(proxyAnthropic, { token: key.secret, body: { model: ANTHROPIC_MODEL } });
    // 1 行記録されている
    const events = recordedEvents();
    expect(events).toHaveLength(1);
    // トークン数は上流の申告どおり
    expect(events[0].inputTokens).toBe(1234);
    expect(events[0].outputTokens).toBe(567);
    // 料金は料金表から計算した値と一致する (料金の正しさ自体は tests/pricing.test.ts が固定する)
    expect(events[0].costMicroUsd).toBe(
      costMicroUsd(Provider.anthropic, ANTHROPIC_MODEL, 1234, 567),
    );
    // 上流のステータスとプロバイダも残る
    expect(events[0].statusCode).toBe(200);
    expect(events[0].provider).toBe(Provider.anthropic);
    // 遅延は負にならない
    expect(events[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('OpenAI の項目名 (prompt_tokens / completion_tokens) からも読み取る', async () => {
    // 上流は OpenAI 形式で申告する
    stubUpstream({ status: 200, body: openAiResponse(11, 22) });
    // 中継する
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    await call(proxyOpenAi, { token: key.secret, body: { model: OPENAI_MODEL } });
    // 記録されたトークン数
    expect(recordedEvents()[0].inputTokens).toBe(11);
    expect(recordedEvents()[0].outputTokens).toBe(22);
    // 料金は OpenAI の単価で計算される
    expect(recordedEvents()[0].costMicroUsd).toBe(
      costMicroUsd(Provider.openai, OPENAI_MODEL, 11, 22),
    );
  });

  it('usage を読めない応答は 0 トークン・0 円で記録し、中継自体は成功させる', async () => {
    // usage の無い応答
    stubUpstream({ status: 200, body: { id: 'msg_test' } });
    // 中継する
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    const result = await call(proxyAnthropic, {
      token: key.secret,
      body: { model: ANTHROPIC_MODEL },
    });
    // 応答は通る
    expect(result.status).toBe(200);
    // 記録は 0 (料金を勝手に作らない)
    expect(recordedEvents()[0].inputTokens).toBe(0);
    expect(recordedEvents()[0].costMicroUsd).toBe(0n);
  });

  it('記録に失敗しても中継結果は返す (記録のために成功した呼び出しを捨てない)', async () => {
    // 上流は正常応答
    stubUpstream({ status: 200, body: anthropicResponse(5, 5) });
    // 記録だけを失敗させる
    vi.spyOn(seed.repos.usageEvents, 'record').mockRejectedValue(new Error('DB 障害'));
    // 中継する
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    const result = await call(proxyAnthropic, {
      token: key.secret,
      body: { model: ANTHROPIC_MODEL },
    });
    // 中継は成功している
    expect(result.status).toBe(200);
  });
});

describe('中継しない呼び出し', () => {
  it('料金表に無いモデルは 422 で、上流を呼ばず記録もしない', async () => {
    // 上流は呼ばれない
    stubUpstream({ status: 200, body: anthropicResponse(1, 1) });
    // 未対応のモデル名
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    const result = await call(proxyAnthropic, {
      token: key.secret,
      body: { model: 'claude-unknown-9' },
    });
    // 422 で、上流も記録も動かない (計れない呼び出しは中継しない)
    expect(result.status).toBe(422);
    expect(fetchCalls).toHaveLength(0);
    expect(recordedEvents()).toHaveLength(0);
  });

  it('プロバイダが違うモデル名も 422 (openai のモデルを anthropic 経路へ出さない)', async () => {
    // 上流は呼ばれない
    stubUpstream({ status: 200, body: anthropicResponse(1, 1) });
    // OpenAI のモデルを Anthropic 経路で指定する
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    const result = await call(proxyAnthropic, { token: key.secret, body: { model: OPENAI_MODEL } });
    // 422
    expect(result.status).toBe(422);
    expect(fetchCalls).toHaveLength(0);
  });

  it('stream: true は 422 (黙って非ストリーミングへ落とさない)', async () => {
    // 上流は呼ばれない
    stubUpstream({ status: 200, body: anthropicResponse(1, 1) });
    // ストリーミング指定
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    const result = await call(proxyAnthropic, {
      token: key.secret,
      body: { model: ANTHROPIC_MODEL, stream: true },
    });
    // 422 で上流は呼ばない
    expect(result.status).toBe(422);
    expect(fetchCalls).toHaveLength(0);
  });

  it('model が無い本文は 422', async () => {
    // 上流は呼ばれない
    stubUpstream({ status: 200, body: anthropicResponse(1, 1) });
    // model を省いた本文
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    const result = await call(proxyAnthropic, { token: key.secret, body: { messages: [] } });
    // 422
    expect(result.status).toBe(422);
  });

  it('上限を超える本文は 413 (上流へ渡さない)', async () => {
    // 上流は呼ばれない
    stubUpstream({ status: 200, body: anthropicResponse(1, 1) });
    // 上限を超える本文
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    const result = await call(proxyAnthropic, {
      token: key.secret,
      body: { model: ANTHROPIC_MODEL, padding: 'a'.repeat(JSON_BODY_MAX_BYTES) },
    });
    // 413
    expect(result.status).toBe(413);
    expect(fetchCalls).toHaveLength(0);
  });

  it('Content-Type が JSON でなければ 415', async () => {
    // 上流は呼ばれない
    stubUpstream({ status: 200, body: anthropicResponse(1, 1) });
    // テキストとして送る
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    const result = await call(proxyAnthropic, {
      token: key.secret,
      method: 'POST',
      rawBody: JSON.stringify({ model: ANTHROPIC_MODEL }),
      headers: { 'content-type': 'text/plain' },
    });
    // 415
    expect(result.status).toBe(415);
  });
});

describe('上流の失敗', () => {
  it('上流の 5xx は 502 にして詳細を返さず、記録は実際のステータスで残す', async () => {
    // 上流が 500 を返す (内部情報を含む本文)
    stubUpstream({ status: 500, body: { error: 'internal upstream detail' } });
    // 中継する
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    const result = await call(proxyAnthropic, {
      token: key.secret,
      body: { model: ANTHROPIC_MODEL },
    });
    // 502 で、上流の本文は返さない
    expect(result.status).toBe(502);
    expect(JSON.stringify(result.json)).not.toContain('internal upstream detail');
    // 記録は残り、ステータスは上流の 500
    expect(recordedEvents()).toHaveLength(1);
    expect(recordedEvents()[0].statusCode).toBe(500);
    expect(recordedEvents()[0].costMicroUsd).toBe(0n);
  });

  it('上流の 4xx はステータスと機械可読な項目だけを返す (自由記述は落とす)', async () => {
    // 上流の 4xx の自由記述には**プラットフォーム側のアカウントの状態**が載る。
    // 実測で確認した例: Anthropic の残高不足は 400 で「credit balance is too low … Plans & Billing」、
    // OpenAI の model_not_found は 404 で「your organization <組織名> does not have access」。
    // ステータス番号では「送り主の本文が悪い 400」と選り分けられないので、項目で絞る (ADR-0007 決定 7)
    stubUpstream({
      status: 400,
      body: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'context_length_exceeded',
          param: 'max_tokens',
          message:
            'Your credit balance is too low. Go to Plans & Billing for organization acme-corp',
        },
        request_id: 'req_011CQabcdef',
      },
    });
    // 中継する
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    const result = await call(proxyAnthropic, {
      token: key.secret,
      body: { model: ANTHROPIC_MODEL },
    });
    // ステータスはそのまま (送り主が再試行の可否を判断できる)
    expect(result.status).toBe(400);
    // 機械可読な項目は残る (どの入力が悪いのかは伝わる)
    const body = result.json as { type?: string; error?: Record<string, unknown> };
    expect(body.type).toBe('error');
    expect(body.error?.type).toBe('invalid_request_error');
    expect(body.error?.code).toBe('context_length_exceeded');
    expect(body.error?.param).toBe('max_tokens');
    // 自由記述と上流の識別子は落ちる
    expect(JSON.stringify(result.json)).not.toContain('credit balance');
    expect(JSON.stringify(result.json)).not.toContain('acme-corp');
    expect(JSON.stringify(result.json)).not.toContain('req_011CQabcdef');
    // 記録も残る
    expect(recordedEvents()[0].statusCode).toBe(400);
  });

  it('許可リストに無い 4xx はステータスごと隠す (402 で課金状態を伝えない)', async () => {
    // 本文を定型文へ差し替えても、**番号そのもの**が共有している上流アカウントの状態を語る。
    // 402 は「プラットフォームの支払いが滞っている」を 1 ビットで伝える (実測でそのまま届いた)。
    // 拒否リストではなく許可リストにしてあるので、ベンダーが新しい番号を使い始めても漏れない
    for (const status of [402, 404, 409, 451]) {
      // このループ内で数えるため毎回空にする
      seed.store.usageEvents.clear();
      stubUpstream({ status, body: { error: { type: 'billing_error' } } });
      // 中継する
      const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
      const result = await call(proxyAnthropic, {
        token: key.secret,
        body: { model: ANTHROPIC_MODEL },
      });
      // 上流のステータスは見せない
      expect(result.status, `${status} が素通りしている`).toBe(502);
      // 記録は**実際の上流のステータス**で残る (Step4 のエラー率ルールが読む)
      expect(recordedEvents()[0].statusCode).toBe(status);
    }
  });

  it('3xx / 4xx の写し先は契約どおり (許可リストの広がりを別の手掛かりで照合する)', async () => {
    // 402 の検査は番号を直書きで列挙するだけなので、**そこに無い番号を許可リストへ足しても気付けない**
    // (実測で、3xx を全部素通しにする変異も 415 を許可リストへ足す変異も全件緑で通った)。
    // ここは実装の集合を import せず、契約の 3 つ組をテスト側に直書きして 300〜499 を総なめする
    // (実装を import すると恒真式になり、集合をどう変えてもテストが一緒に動いてしまう)
    const RELAYED = new Set([400, 413, 422]);
    // 300 から 499 まで
    for (let status = 300; status < 500; status += 1) {
      // 本文を持てないステータスは別の検査が扱う (本文を渡せないのでこのループでは測れない)
      if (BODYLESS_STATUSES.has(status)) continue;
      // このループ内で数えるため毎回空にする
      seed.store.usageEvents.clear();
      stubUpstream({ status, body: { error: { type: 'invalid_request_error' } } });
      // 中継する
      const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
      const result = await call(proxyAnthropic, {
        token: key.secret,
        body: { model: ANTHROPIC_MODEL },
      });
      // 許可リストならそのまま、429 は 429、それ以外は 502
      const expected = RELAYED.has(status) ? status : status === 429 ? 429 : 502;
      expect(result.status, `上流 ${status} の写し先`).toBe(expected);
    }
  });

  it('ステータスの 2 つの表は重ならない (同じ番号を両方に書かない)', () => {
    // 写像の表 (401/403/429) と許可リスト (400/413/422) は「上流のステータス N をどうするか」への
    // 2 つの参照元。`??` の順で写像の表が先勝ちなので挙動は決まるが、重なり自体は誰も見ていなかった
    const masked = Object.keys(UPSTREAM_STATUS_MASKING).map(Number);
    // 許可リストに写像の表の番号が入っていないこと
    for (const status of masked) {
      expect(RELAYABLE_CLIENT_ERROR_STATUSES.has(status), `${status} が両方の表にある`).toBe(false);
    }
  });

  it.each([400, 413, 422])(
    '許可リストにある %i は「送り主の要求についての診断」なのでステータスを保つ',
    async (status) => {
      // 許可リストが厳しすぎて全部 502 になっていないことを確かめる (両方向を塞ぐ)
      stubUpstream({ status, body: { error: { type: 'invalid_request_error' } } });
      // 中継する
      const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
      const result = await call(proxyAnthropic, {
        token: key.secret,
        body: { model: ANTHROPIC_MODEL },
      });
      // ステータスはそのまま、本文は絞ったうえで返る
      expect(result.status).toBe(status);
      expect((result.json as { error?: Record<string, unknown> }).error?.type).toBe(
        'invalid_request_error',
      );
    },
  );

  it('上流の Retry-After は混雑 (429) 以外へは中継しない', async () => {
    // 401 を 502 へ写すときに待ち時間まで渡すと、「この 502 はバックオフ由来だ」という
    // プラットフォーム側の状態が利用者へ伝わる (上流のアカウントは全テナント共有)
    for (const status of [401, 403, 500]) {
      // このループ内で数えるため毎回空にする
      seed.store.usageEvents.clear();
      stubUpstream({ status, body: { error: 'x' }, headers: { 'retry-after': '3600' } });
      // 中継する
      const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
      const result = await call(proxyAnthropic, {
        token: key.secret,
        body: { model: ANTHROPIC_MODEL },
      });
      // どれも 502 で、待ち時間の指示は付かない
      expect(result.status, `${status} の写し先が違う`).toBe(502);
      expect(result.headers.get('Retry-After'), `${status} で Retry-After が漏れている`).toBeNull();
    }
  });

  it('形の違う Retry-After は中継しない (整数の秒数だけを通す)', async () => {
    // 上流の値を検証せず素通ししていたときは、非数値のバイト列も HTTP-date もそのまま届いた
    stubUpstream({
      status: 429,
      body: { error: 'busy' },
      headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
    });
    // 中継する
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    const result = await call(proxyAnthropic, {
      token: key.secret,
      body: { model: ANTHROPIC_MODEL },
    });
    // 429 は返るが、形の違う待ち時間は落とす
    expect(result.status).toBe(429);
    expect(result.headers.get('Retry-After')).toBeNull();
  });

  it('上流の 401 / 403 は 502 に写して本文を返さない (上流アカウントの状態を漏らさない)', async () => {
    // 上流の 401 の本文には部分マスクした API キーや組織名が載る。4xx をそのまま素通しすると、
    // 有効なキーを持つ全テナントがそれを観測できてしまう (ADR-0007 の決定 7)
    for (const status of [401, 403]) {
      // 記録と呼び出しの履歴をこのループ内で数えるため、毎回空にする
      fetchCalls = [];
      seed.store.usageEvents.clear();
      // 上流が資格情報を拒否する (内部情報を含む本文)
      stubUpstream({ status, body: { error: { message: 'invalid x-api-key sk-ant-...9f2' } } });
      // 中継する
      const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
      const result = await call(proxyAnthropic, {
        token: key.secret,
        body: { model: ANTHROPIC_MODEL },
      });
      // 利用者には中継の失敗としてだけ伝える
      expect(result.status, `${status} を素通ししている`).toBe(502);
      expect(JSON.stringify(result.json)).not.toContain('sk-ant-');
      // 記録は**実際の上流のステータス**で 1 行だけ残る (二重記録もしない)
      expect(recordedEvents()).toHaveLength(1);
      expect(recordedEvents()[0].statusCode).toBe(status);
    }
  });

  it('上流の 429 は 429 のまま返すが本文は定型文にし、Retry-After だけ中継する', async () => {
    // 混雑は「待てば通る」情報に意味があるので 429 のまま返す。本文にはクォータや組織名が載るので返さない
    stubUpstream({
      status: 429,
      body: { error: { message: 'rate limit for organization acme-corp' } },
      headers: { 'retry-after': '7' },
    });
    // 中継する
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    const result = await call(proxyAnthropic, {
      token: key.secret,
      body: { model: ANTHROPIC_MODEL },
    });
    // ステータスは 429 のまま
    expect(result.status).toBe(429);
    // 上流の本文は返さない
    expect(JSON.stringify(result.json)).not.toContain('acme-corp');
    // 待ち時間の指示だけは中継する (クライアントの再試行嵐を防ぐ)
    expect(result.headers.get('Retry-After')).toBe('7');
    // 記録は 429 で 1 行
    expect(recordedEvents()).toHaveLength(1);
    expect(recordedEvents()[0].statusCode).toBe(429);
  });

  it('上流の本文が JSON として読めなければ 502 (中身も返さない)', async () => {
    // 前段のゲートウェイが HTML のエラーページを返す形。JSON だと名乗って HTML を返すと
    // クライアントの解釈が理由不明で失敗し、中身は上流側の内部情報でもある
    stubUpstream({
      status: 200,
      rawBody: '<html><body>upstream gateway error: pool exhausted</body></html>',
      contentType: 'text/html; charset=utf-8',
    });
    // 中継する
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    const result = await call(proxyAnthropic, {
      token: key.secret,
      body: { model: ANTHROPIC_MODEL },
    });
    // 502 で、上流の本文は返さない
    expect(result.status).toBe(502);
    expect(JSON.stringify(result.json)).not.toContain('pool exhausted');
    // 上流は実際に呼ばれているので記録は残る (ステータスは上流の 200)
    expect(recordedEvents()).toHaveLength(1);
    expect(recordedEvents()[0].statusCode).toBe(200);
  });

  it('本文を持てないステータス (204) でも 500 にならず 502 になる', async () => {
    // 204 の本文は空文字なので JSON として読めない。**本文ごと Response へ渡すと TypeError** になり、
    // 上流の異常が「自分の内部エラー」= 500 とスタック付きのログに化けていた (実測)
    stubUpstream({ status: 204 });
    // 中継する
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    const result = await call(proxyAnthropic, {
      token: key.secret,
      body: { model: ANTHROPIC_MODEL },
    });
    // 上流の異常として 502 (自分の内部エラーにしない)
    expect(result.status).toBe(502);
  });

  it('Content-Type が違っても本文が JSON なら中継する (課金だけして捨てない)', async () => {
    // 前段が Content-Type を付け替えただけの正しい JSON を捨てると、トークン分を記録したのに
    // 応答は返さない「課金だけして捨てる」経路になる (実測で 33,000 マイクロ USD を記録して 502 を返した)
    stubUpstream({
      status: 200,
      body: anthropicResponse(1000, 2000),
      contentType: 'text/plain; charset=utf-8',
    });
    // 中継する
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    const result = await call(proxyAnthropic, {
      token: key.secret,
      body: { model: ANTHROPIC_MODEL },
    });
    // 応答は返り、記録した料金と釣り合う
    expect(result.status).toBe(200);
    expect(recordedEvents()[0].inputTokens).toBe(1000);
    expect(recordedEvents()[0].costMicroUsd).toBeGreaterThan(0n);
  });

  it('上流が時間内に応答しなければ 504 で、記録も残す', async () => {
    // AbortSignal.timeout が投げるのと同じ名前の例外
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    stubUpstream(timeout);
    // 中継する
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    const result = await call(proxyAnthropic, {
      token: key.secret,
      body: { model: ANTHROPIC_MODEL },
    });
    // 504
    expect(result.status).toBe(504);
    // 記録は 504 として残る (Step4 のエラー率ルールが読む)
    expect(recordedEvents()[0].statusCode).toBe(504);
  });

  it('上流へ接続できなければ 502 で、記録も残す', async () => {
    // 接続不能を模す
    stubUpstream(new Error('connect ECONNREFUSED'));
    // 中継する
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    const result = await call(proxyAnthropic, {
      token: key.secret,
      body: { model: ANTHROPIC_MODEL },
    });
    // 502
    expect(result.status).toBe(502);
    // 記録は 502 として残る
    expect(recordedEvents()[0].statusCode).toBe(502);
  });

  it('上流の資格情報が未設定なら 503 (呼びに行かない)', async () => {
    // 環境変数を空にする
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    // 上流は呼ばれない
    stubUpstream({ status: 200, body: anthropicResponse(1, 1) });
    // 中継する
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    const result = await call(proxyAnthropic, {
      token: key.secret,
      body: { model: ANTHROPIC_MODEL },
    });
    // 503 で、上流は呼ばない
    expect(result.status).toBe(503);
    expect(fetchCalls).toHaveLength(0);
    // **記録もしない** — 上流へ 1 バイトも出ていない呼び出しを利用イベントにすると、
    // 上流が未設定のあいだ有効なキー 1 本で DB の行だけを無制限に増やせる (実測)
    expect(recordedEvents()).toHaveLength(0);
  });
});

describe('サーバログ', () => {
  it('トークン数を読めなかったログは 2xx のときだけ出す', async () => {
    // console.error を覗く (出し過ぎも出さなすぎも見る)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // 2xx なのに usage が無い応答 = 本物の異常なので残す
    stubUpstream({ status: 200, body: { id: 'x' } });
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    await call(proxyAnthropic, { token: key.secret, body: { model: ANTHROPIC_MODEL } });
    // 1 回だけ出る
    expect(logged.mock.calls.filter((args) => String(args[0]).includes('トークン数'))).toHaveLength(
      1,
    );
    // 4xx では出さない (上流のエラー本文に usage は載らないので必ず読めず、
    // 安く量産できる 400 でログが埋まって本物の異常が隠れる)
    logged.mockClear();
    stubUpstream({ status: 400, body: { error: { type: 'invalid_request_error' } } });
    await call(proxyAnthropic, { token: key.secret, body: { model: ANTHROPIC_MODEL } });
    // 1 回も出ない
    expect(logged.mock.calls.filter((args) => String(args[0]).includes('トークン数'))).toHaveLength(
      0,
    );
  });
});

describe('遅延の記録', () => {
  it('上流にかかった時間を latencyMs として記録する', async () => {
    // 上流が 30 ミリ秒かけて応答する
    const delayMs = 30;
    stubUpstream({ status: 200, body: anthropicResponse(1, 1), delayMs });
    // 中継する
    const key = seedApiKey(seed, { tenantId: seed.a.id, agentId: seed.a.agent.id });
    await call(proxyAnthropic, { token: key.secret, body: { model: ANTHROPIC_MODEL } });
    // 測った時間が記録されている (0 固定や未計測の変異を落とす。上振れは環境次第なので下限だけ見る)
    expect(recordedEvents()[0].latencyMs).toBeGreaterThanOrEqual(delayMs);
  });
});
