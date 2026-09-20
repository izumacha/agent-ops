// 上流への接続先の決め方 (src/lib/proxy/upstream.ts)。**ここが SSRF の防御線**で、
// 「接続先はコードと環境変数だけから決まる」ことを固定する。
// 呼び出しそのもの (ヘッダ・タイムアウト・記録) は tests/api/proxy.test.ts が API 経路で見る
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callUpstream, resolveUpstreamBaseUrl, upstreamEndpoint } from '@/lib/proxy/upstream';
import { readUpstreamUsage } from '@/lib/proxy/usage';
import { ApiError } from '@/lib/api/errors';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { UPSTREAM_MAX_RESPONSE_BYTES, USAGE_TOKENS_MAX } from '@/lib/constants';
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

  it('基底 URL のパスが // で始まっても接続先のホストは動かない (プロトコル相対 URL の罠)', () => {
    // 末尾スラッシュの打ち間違いを模す。`new URL(path, base)` で組み立てると、この部分が
    // **プロトコル相対 URL**として解釈され、上流の API キーごと別ホストへ送られる (実測)。
    // resolveUpstreamBaseUrl はパスを検査しないので、この基底 URL 自体は設定として通る
    const url = upstreamEndpoint(
      Provider.anthropic,
      env({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com//evil.example.com' }),
    );
    // 接続先のホストは基底の origin から動かない
    expect(url.origin).toBe('https://api.anthropic.com');
    expect(url.hostname).not.toBe('evil.example.com');
  });

  it('バックスラッシュで始まるパスでも接続先のホストは動かない', () => {
    // WHATWG の URL はバックスラッシュをスラッシュとして扱うので、`\\host` も同じ罠になる
    const url = upstreamEndpoint(
      Provider.openai,
      env({ OPENAI_BASE_URL: 'https://api.openai.com/\\evil.example.com' }),
    );
    // 接続先のホストは基底の origin から動かない
    expect(url.origin).toBe('https://api.openai.com');
    expect(url.hostname).not.toBe('evil.example.com');
  });
});

describe('上流の呼び出し (時間切れ・本文の上限)', () => {
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

  it('応答本文が上限を超えたら 502 (全量をメモリへ載せない)', async () => {
    // 壊れた前段ゲートウェイが巨大な本文を返す形。response.text() で読んでいたときは
    // 64 MiB を丸ごとバッファした (実測)。上限を超えたら読むのをやめて 502 にする
    const chunk = new TextEncoder().encode('x'.repeat(1024));
    // 上限 (2 KiB) を必ず超える本文をストリームで返す
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                // 1 KiB のかたまりを 8 回流す
                for (let i = 0; i < 8; i += 1) controller.enqueue(chunk);
                controller.close();
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    // 小さな上限で呼ぶ
    const failure = await callUpstream({
      provider: Provider.anthropic,
      target: { endpoint: new URL('https://api.anthropic.com/v1/messages'), apiKey: 'k' },
      body: '{}',
      maxResponseBytes: 2 * 1024,
    }).catch((error: unknown) => error);
    // 上流の応答が使えなかったので 502
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_STATUS.BAD_GATEWAY);
  });

  it('上限を渡さなければ既定値 (UPSTREAM_MAX_RESPONSE_BYTES) が効く', async () => {
    // **既定値の結線を見る検査**。上の 2 件は上限を明示で渡すので、
    // `?? UPSTREAM_MAX_RESPONSE_BYTES` を `?? Infinity` に変えても全件緑のままだった (実測)
    const chunk = new Uint8Array(64 * 1024).fill(0x78);
    // 既定の上限をちょうど超える回数だけ流す
    const times = Math.ceil(UPSTREAM_MAX_RESPONSE_BYTES / chunk.byteLength) + 1;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                // 上限を超えるまで流す
                for (let i = 0; i < times; i += 1) controller.enqueue(chunk);
                controller.close();
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    // 上限を渡さずに呼ぶ (本番と同じ結線)
    const failure = await callUpstream({
      provider: Provider.anthropic,
      target: { endpoint: new URL('https://api.anthropic.com/v1/messages'), apiKey: 'k' },
      body: '{}',
    }).catch((error: unknown) => error);
    // 既定の上限で打ち切られて 502
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_STATUS.BAD_GATEWAY);
  });

  it('上限を超えたら下層のストリームも解放する (ソケットを抱え続けない)', async () => {
    // 読むのをやめるだけだと応答ボディが未消費のまま残り、fd がタイムアウトまで解放されない
    // (実測で 502 を返した 20 秒後もソケットが閉じなかった)。cancel が呼ばれることを見る
    let cancelled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                // 止めるまで流し続ける
                controller.enqueue(new Uint8Array(1024).fill(0x78));
              },
              cancel() {
                // 解放されたことを記録する
                cancelled = true;
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    // 小さな上限で呼ぶ
    await callUpstream({
      provider: Provider.anthropic,
      target: { endpoint: new URL('https://api.anthropic.com/v1/messages'), apiKey: 'k' },
      body: '{}',
      maxResponseBytes: 2 * 1024,
    }).catch(() => undefined);
    // 下層のストリームが解放されている
    expect(cancelled).toBe(true);
  });

  it('本文が UTF-8 として壊れていても 502 (置換して中継しない)', async () => {
    // 上限超過と壊れたバイト列は別の理由。片方しか見ていないと、もう一方の写像先が無検証になる
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array([0xff, 0xfe, 0xfd]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    // 呼ぶ
    const failure = await callUpstream({
      provider: Provider.anthropic,
      target: { endpoint: new URL('https://api.anthropic.com/v1/messages'), apiKey: 'k' },
      body: '{}',
    }).catch((error: unknown) => error);
    // 502 (U+FFFD へ置換した本文を中継しない)
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_STATUS.BAD_GATEWAY);
  });

  it('上限内の本文はそのまま読める (上限が常に噛むわけではない)', async () => {
    // 上の検査が「いつも 502」になっていないことを確かめる
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    // 同じ小さな上限でも、収まる本文は読める
    const result = await callUpstream({
      provider: Provider.anthropic,
      target: { endpoint: new URL('https://api.anthropic.com/v1/messages'), apiKey: 'k' },
      body: '{}',
      maxResponseBytes: 2 * 1024,
    });
    // 本文がそのまま返る
    expect(JSON.parse(result.body)).toEqual({ ok: true });
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
    // **保存できる範囲を超える申告**。安全な整数まで通していたときは、記録が P2020 で落ちて
    // `recordUsage` がそれを飲み、利用イベントが 1 行も残らなかった (実測)。中継は成功しているので
    // 上流の課金は発生しており、「課金されたのに台帳に無い」状態になる (ADR-0007 決定 5)
    [
      '入力トークン数が列の範囲を超える',
      { usage: { input_tokens: USAGE_TOKENS_MAX + 1, output_tokens: 4 } },
    ],
    [
      '出力トークン数が列の範囲を超える',
      { usage: { input_tokens: 4, output_tokens: Number.MAX_SAFE_INTEGER } },
    ],
    ['応答が null', null],
    ['応答が配列', []],
  ])('%s ときは null (上流の申告値をそのまま信じない)', (_label, payload) => {
    // 読めなければ null (呼び出し側が「計測できなかった」として扱う)
    expect(readUpstreamUsage(Provider.anthropic, payload)).toBeNull();
  });

  it('列の範囲ちょうどは通す (絞りすぎて計測が消えていない)', () => {
    // 上限ちょうどは保存できるので読めること (上側だけを見ると、上限をいくら下げても気付けない)
    expect(
      readUpstreamUsage(Provider.anthropic, {
        usage: { input_tokens: USAGE_TOKENS_MAX, output_tokens: 0 },
      }),
    ).toEqual({ inputTokens: USAGE_TOKENS_MAX, outputTokens: 0 });
  });
});
