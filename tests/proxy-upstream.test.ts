// 上流への接続先の決め方 (src/lib/proxy/upstream.ts)。**ここが SSRF の防御線**で、
// 「接続先はコードと環境変数だけから決まる」ことを固定する。
// 呼び出しそのもの (ヘッダ・タイムアウト・記録) は tests/api/proxy.test.ts が API 経路で見る
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  callUpstream,
  resolveUpstreamBaseUrl,
  upstreamEndpoint,
  upstreamEnvNames,
} from '@/lib/proxy/upstream';
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

// 上流の失敗は利用者へ定型文しか返さないので、**残るのはサーバログだけ**。
// 記録が無いと、接続不能も時間切れも証明書エラーも運用者からはまったく見えない
// (この記録を足すまで、502 / 504 を返すテストを流しても関連するログは 1 行も出なかった)。
// 同時に、**その記録に message が混ざらないこと**も固定する — 上流由来の文字列には
// 組織名・残高・接続文字列が載りうるので、形は必ず describeError に任せる
describe('上流の失敗の記録', () => {
  // 差し替えた fetch と console を元へ戻す
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // 失敗する上流を立てて呼び、そのあいだに出た console.error の引数を返す
  async function callAndCaptureLog(
    fetchImpl: () => Promise<Response>,
  ): Promise<{ status: number; calls: unknown[][] }> {
    // 実際の出力は抑えつつ引数だけ記録する
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // 失敗する上流に差し替える
    vi.stubGlobal('fetch', vi.fn(fetchImpl));
    // 呼ぶ (必ず ApiError になる)
    const failure = await callUpstream({
      provider: Provider.anthropic,
      target: { endpoint: new URL('https://api.anthropic.com/v1/messages'), apiKey: 'k' },
      body: '{}',
      timeoutMs: 20,
      maxResponseBytes: 2 * 1024,
    }).catch((error: unknown) => error);
    // ApiError であること (そうでなければ以降の照合が意味を持たない)
    expect(failure).toBeInstanceOf(ApiError);
    // 記録された引数と、写った HTTP ステータス
    return { status: (failure as ApiError).status, calls: logged.mock.calls };
  }

  it('接続不能を 502 として記録する (message は載せない)', async () => {
    // undici が接続不能を包む形 (cause に実際の理由が入る)。message に接続文字列を仕込む
    const cause = Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:443'), {
      code: 'ECONNREFUSED',
    });
    const { status, calls } = await callAndCaptureLog(() =>
      Promise.reject(new TypeError('fetch failed: postgres://app:secret@db', { cause })),
    );
    // 502 へ写り、記録はちょうど 1 行
    expect(status).toBe(HTTP_STATUS.BAD_GATEWAY);
    expect(calls, '上流の失敗が 1 行も記録されていない').toHaveLength(1);
    // 2 つ目の引数が describeError の形 (name と、cause を 1 段たどった code が残る)
    expect(calls[0][1]).toMatchObject({ name: 'TypeError', cause: { code: 'ECONNREFUSED' } });
    // **message は 1 バイトも出ない** (接続文字列が載っていた)
    expect(JSON.stringify(calls[0])).not.toContain('postgres://');
    expect(JSON.stringify(calls[0])).not.toContain('10.0.0.9');
  });

  it('時間切れを 504 として記録する', async () => {
    // 合図が中断になったら TimeoutError で終わる上流 (本物の fetch と同じ振る舞い)
    const { status, calls } = await callAndCaptureLog(
      () =>
        new Promise<Response>((_resolve, reject) => {
          // 中断の合図を待つ
          const timeout = Object.assign(new Error('The operation was aborted'), {
            name: 'TimeoutError',
          });
          setTimeout(() => {
            reject(timeout);
          }, 30);
        }),
    );
    // 504 へ写り、記録はちょうど 1 行
    expect(status).toBe(HTTP_STATUS.GATEWAY_TIMEOUT);
    expect(calls, '時間切れが 1 行も記録されていない').toHaveLength(1);
    // 例外の種類は残る (これが無いと運用者は 504 の理由を切り分けられない)
    expect(calls[0][1]).toMatchObject({ name: 'TimeoutError' });
  });

  it('応答本文が上限を超えた 502 も記録する (ApiError は catch を素通りする)', async () => {
    // 上限 (2 KiB) を必ず超える本文。**この経路は catch の手前で throw する**ので、
    // 下の catch の記録には届かない — 記録が無いと 502 の理由が運用者に見えない
    const chunk = new TextEncoder().encode('x'.repeat(1024));
    const { status, calls } = await callAndCaptureLog(async () =>
      Promise.resolve(
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
    // 502 へ写り、記録はちょうど 1 行
    expect(status).toBe(HTTP_STATUS.BAD_GATEWAY);
    expect(calls, '上限超過が 1 行も記録されていない').toHaveLength(1);
    // 理由が読み取れること (上流由来の文字列は混ぜない)
    expect(String(calls[0][0])).toContain('上限');
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

  it('受け入れ上限は UsageEvent の列の型から決まる値に一致する', () => {
    // **2 つの境界の検査はどちらも定数を基準に書いてある**ので、定数を動かすと期待値も一緒に動く。
    // 実測で `USAGE_TOKENS_MAX` を 2^40 にしても 10_000 にしても全件緑だった — 前者は
    // このガードが塞いだ「記録が落ちて台帳に 1 行も残らない」を戻し、後者は正当な長文の呼び出しを
    // ほぼ全部「計測できなかった」へ落とす (料金 0 の行だけが残る)。**独立な手がかり**として
    // `prisma/schema.prisma` の列の型を読み、その型が保持できる最大値と突き合わせる
    const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
    // UsageEvent の定義だけを切り出す
    const model = /model UsageEvent \{([\s\S]*?)\n\}/.exec(schema)?.[1];
    // 読めなければ照合にならない (fail-closed)
    expect(model, 'UsageEvent の定義を読めない').toBeDefined();
    // Prisma のスカラー型 → その型が保持できる最大の整数 (PostgreSQL の仕様)
    const scalarMax: Readonly<Record<string, number>> = { Int: 2_147_483_647 };
    // トークン数の 2 列を見る
    for (const column of ['inputTokens', 'outputTokens']) {
      // その列の型を読む
      const declared = new RegExp(`\\n\\s*${column}\\s+(\\w+)`).exec(model ?? '')?.[1];
      // 型が読めなければ照合にならない
      expect(declared, `${column} の型を読めない`).toBeDefined();
      // 知っている型であること (BigInt などへ変えたらこの表を増やす)
      expect(
        scalarMax[declared ?? ''],
        `${column} の型 ${declared} に対応する上限を知らない (USAGE_TOKENS_MAX を見直すこと)`,
      ).toBeDefined();
      // 定数がその型の最大値と一致すること
      expect(USAGE_TOKENS_MAX, `${column} の型 ${declared} と USAGE_TOKENS_MAX が食い違う`).toBe(
        scalarMax[declared ?? ''],
      );
    }
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

describe('upstreamEnvNames', () => {
  it('全プロバイダの接続先と資格情報の変数名を役割つきで返す', () => {
    // **ベンチがローカルのスタブへ差し替える一覧の正本** (写しを持つと足し忘れで実 API を叩く)。
    // 役割 (接続先 / 資格情報) をここで付けて返すので、呼び出し側が名前で分類し直さずに済む
    expect(upstreamEnvNames()).toEqual([
      { baseUrlEnv: 'ANTHROPIC_BASE_URL', apiKeyEnv: 'ANTHROPIC_API_KEY' },
      { baseUrlEnv: 'OPENAI_BASE_URL', apiKeyEnv: 'OPENAI_API_KEY' },
    ]);
  });

  it('接続先と資格情報を取り違えていない', () => {
    // 取り違えると「資格情報に URL を入れる」形になり、上流のダミー化が成立しなくなる
    for (const { baseUrlEnv, apiKeyEnv } of upstreamEnvNames()) {
      expect(baseUrlEnv).toContain('BASE_URL');
      expect(apiKeyEnv).toContain('API_KEY');
    }
  });
});
