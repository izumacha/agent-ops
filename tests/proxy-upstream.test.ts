// 上流への接続先の決め方 (src/lib/proxy/upstream.ts)。**ここが SSRF の防御線**で、
// 「接続先はコードと環境変数だけから決まる」ことを固定する。
// 呼び出しそのもの (ヘッダ・タイムアウト・記録) は tests/api/proxy.test.ts が API 経路で見る
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callUpstream, resolveUpstreamBaseUrl, upstreamEndpoint } from '@/lib/proxy/upstream';
import { readUpstreamUsage } from '@/lib/proxy/usage';
import { ApiError } from '@/lib/api/errors';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { Provider } from '@/domain/types';

// 環境変数の入れ物を作る (process.env を汚さずに判定だけを試す)
function env(values: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  // NODE_ENV は既定で test (ループバックの http を許す側)
  return { NODE_ENV: 'test', ...values } as NodeJS.ProcessEnv;
}

describe('接続先の決定', () => {
  it('環境変数が無ければ公式の https へ向く', () => {
    // Anthropic
    expect(resolveUpstreamBaseUrl(Provider.anthropic, env()).origin).toBe(
      'https://api.anthropic.com',
    );
    // OpenAI
    expect(resolveUpstreamBaseUrl(Provider.openai, env()).origin).toBe('https://api.openai.com');
  });

  it('https の指定は受け付ける (社内ゲートウェイ等)', () => {
    // 運用者が設定した https の接続先
    const url = resolveUpstreamBaseUrl(
      Provider.anthropic,
      env({ ANTHROPIC_BASE_URL: 'https://gateway.example.com/llm' }),
    );
    // そのまま使う
    expect(url.href).toBe('https://gateway.example.com/llm');
  });

  it('空文字の指定は未設定と同じ扱い (公式へ向く)', () => {
    // 空の環境変数は設定ミスなので、平文や別ホストへ落ちない側へ倒す
    expect(resolveUpstreamBaseUrl(Provider.openai, env({ OPENAI_BASE_URL: '   ' })).origin).toBe(
      'https://api.openai.com',
    );
  });

  it.each([
    ['ループバック (IPv4)', 'http://127.0.0.1:4010'],
    ['ループバック (localhost)', 'http://localhost:4010'],
  ])('%s の http は非本番でだけ許す', (_label, base) => {
    // 非本番 (テスト・開発) のスタブ上流
    expect(
      resolveUpstreamBaseUrl(Provider.anthropic, env({ ANTHROPIC_BASE_URL: base })).protocol,
    ).toBe('http:');
  });

  it('本番ではループバックの http も許さない (平文の中継を作らない)', () => {
    // NODE_ENV=production
    expect(() =>
      resolveUpstreamBaseUrl(
        Provider.anthropic,
        env({ NODE_ENV: 'production', ANTHROPIC_BASE_URL: 'http://127.0.0.1:4010' }),
      ),
    ).toThrow(ApiError);
  });

  it.each([
    ['ループバックでない http', 'http://internal.example.com'],
    ['メタデータ サービス', 'http://169.254.169.254'],
    ['プライベート IP', 'http://10.0.0.5:8080'],
    ['file スキーム', 'file:///etc/passwd'],
    ['資格情報付き URL', 'https://user:pass@api.anthropic.com'],
    ['クエリ付き', 'https://api.anthropic.com?x=1'],
    ['フラグメント付き', 'https://api.anthropic.com#x'],
    ['URL として読めない', 'not-a-url'],
  ])('%s は拒否する (fail-closed)', (_label, base) => {
    // どれも設定ミス・危険な指定として拒否する
    expect(() =>
      resolveUpstreamBaseUrl(Provider.anthropic, env({ ANTHROPIC_BASE_URL: base })),
    ).toThrow(ApiError);
  });

  it('中継先のパスはプロバイダごとに固定 (クライアントの URL は使わない)', () => {
    // Anthropic
    expect(upstreamEndpoint(Provider.anthropic, env()).pathname).toBe('/v1/messages');
    // OpenAI
    expect(upstreamEndpoint(Provider.openai, env()).pathname).toBe('/v1/chat/completions');
  });

  it('基底 URL にパスがあれば、その下に固定パスを足す', () => {
    // 末尾スラッシュの有無で結果が変わらないこと
    const withSlash = upstreamEndpoint(
      Provider.anthropic,
      env({ ANTHROPIC_BASE_URL: 'https://gateway.example.com/llm/' }),
    );
    const withoutSlash = upstreamEndpoint(
      Provider.anthropic,
      env({ ANTHROPIC_BASE_URL: 'https://gateway.example.com/llm' }),
    );
    // どちらも同じ接続先
    expect(withSlash.href).toBe('https://gateway.example.com/llm/v1/messages');
    expect(withoutSlash.href).toBe(withSlash.href);
  });
});

describe('上流の呼び出し (時間切れ)', () => {
  // 差し替えた fetch を元へ戻す
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('上限の時間までに応答しなければ 504 にする (実際に中断する)', async () => {
    // 応答を返さず、中断の合図が来たときだけ AbortError で終わる上流を模す
    // (fetch の実装と同じ振る舞い。AbortSignal.timeout は Node 内部のタイマーで動くので
    //  偽タイマーでは進められず、**短い上限を渡して実時間で確かめる**のが唯一の方法)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: string | URL | Request, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            // 合図が中断になったら、fetch と同じく例外で終わる
            init?.signal?.addEventListener('abort', () => {
              const aborted = new Error('aborted');
              // AbortSignal.timeout は理由として TimeoutError を渡す
              aborted.name = (init.signal?.reason as Error | undefined)?.name ?? 'AbortError';
              reject(aborted);
            });
          }),
      ),
    );
    // ごく短い上限で呼ぶ (既定の 2 分を待たない)
    const failure = await callUpstream({
      provider: Provider.anthropic,
      target: { endpoint: new URL('https://api.anthropic.com/v1/messages'), apiKey: 'k' },
      body: '{}',
      timeoutMs: 20,
    }).catch((error: unknown) => error);
    // 504 として扱われる (合図を渡していなければ、この呼び出しは永久に解決しない)
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_STATUS.GATEWAY_TIMEOUT);
  });
});

describe('上流の応答からのトークン数の読み取り', () => {
  it('Anthropic の項目名を読む', () => {
    // input_tokens / output_tokens
    expect(
      readUpstreamUsage(Provider.anthropic, { usage: { input_tokens: 3, output_tokens: 4 } }),
    ).toEqual({ inputTokens: 3, outputTokens: 4 });
  });

  it('OpenAI の項目名を読む', () => {
    // prompt_tokens / completion_tokens
    expect(
      readUpstreamUsage(Provider.openai, { usage: { prompt_tokens: 5, completion_tokens: 6 } }),
    ).toEqual({ inputTokens: 5, outputTokens: 6 });
  });

  it('プロバイダが違えば項目名も違う (取り違えを読み取らない)', () => {
    // Anthropic の応答を OpenAI として読むと項目が見つからない
    expect(
      readUpstreamUsage(Provider.openai, { usage: { input_tokens: 3, output_tokens: 4 } }),
    ).toBeNull();
  });

  it.each([
    ['usage が無い', { id: 'x' }],
    ['usage がオブジェクトでない', { usage: 7 }],
    ['トークン数が文字列', { usage: { input_tokens: '3', output_tokens: 4 } }],
    ['トークン数が負', { usage: { input_tokens: -1, output_tokens: 4 } }],
    ['トークン数が小数', { usage: { input_tokens: 1.5, output_tokens: 4 } }],
    ['応答が null', null],
    ['応答が配列', []],
  ])('%s ときは null (上流の申告値をそのまま信じない)', (_label, payload) => {
    // 読めなければ null (呼び出し側が「計測できなかった」として扱う)
    expect(readUpstreamUsage(Provider.anthropic, payload)).toBeNull();
  });
});
