// 通知の送信 (src/lib/notify/send.ts) と外向き URL の規則 (src/lib/outbound-url.ts) の検査。
// **実際のネットワークへは出さない** — fetch を差し替えて「何を・どこへ・どの形で送ったか」を見る。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  notifyGuardrailIncident,
  NOTIFY_SIGNING_SECRET_ENV,
  NOTIFY_URL_ENV,
  NotifyChannel,
  type NotifyPayload,
} from '@/lib/notify/send';
import {
  NOTIFY_SIGNATURE_HEADER,
  NOTIFY_SIGNING_SECRET_MIN_LENGTH,
  NOTIFY_TIMEOUT_MS,
} from '@/lib/constants';
import { OutboundUrlRejection, parseOutboundUrl } from '@/lib/outbound-url';

// 署名鍵 (下限を満たす固定値)
const SECRET = 'notify-test-signing-secret-0123456789';
// 通知の宛先 (https のスタブ)
const WEBHOOK_URL = 'https://hooks.example.com/agent-ops?token=abc';
// メール中継の宛先
const MAIL_URL = 'https://mail.example.com/send';

// 送る内容 (機微情報を含まない形)
const PAYLOAD: NotifyPayload = {
  tenantId: 'tenant_1',
  agentId: 'agent_1',
  kind: 'cost',
  incidentId: 'incident_1',
  summary: 'コストが上限を超えました',
  suspended: true,
  occurredAt: '2026-10-02T12:00:00.000Z',
};

// 環境変数を組み立てる (NODE_ENV は ProcessEnv で必須)
function env(values: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  // 既定は「両方の宛先と署名鍵が設定されている」状態
  return {
    NODE_ENV: 'test',
    [NOTIFY_URL_ENV[NotifyChannel.webhook]]: WEBHOOK_URL,
    [NOTIFY_URL_ENV[NotifyChannel.email]]: MAIL_URL,
    [NOTIFY_SIGNING_SECRET_ENV]: SECRET,
    ...values,
  } as NodeJS.ProcessEnv;
}

// fetch の呼び出しを記録しつつ、与えた応答を返すスタブを立てる
function stubFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  // 呼び出しの記録
  const calls: { url: string; init: RequestInit }[] = [];
  // fetch を差し替える
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    // 呼び出しを記録する
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    // 与えられた応答を返す
    return respond(url, init);
  });
  // 記録を呼び出し側へ渡す
  return calls;
}

describe('外向き URL の規則', () => {
  it('https は受け付ける (クエリ付きも通す)', () => {
    // 通知の宛先はクエリに受け手のトークンを載せる形が普通にある
    const result = parseOutboundUrl('https://hooks.example.com/x?token=abc', env());
    expect(result.ok).toBe(true);
  });

  it('資格情報付き URL は拒否する (ログや Referer に漏れる形)', () => {
    // user:pass@host の形
    expect(parseOutboundUrl('https://user:pass@hooks.example.com/x', env())).toEqual({
      ok: false,
      reason: OutboundUrlRejection.credentials_in_url,
    });
  });

  it('URL として読めない値は拒否する', () => {
    // スキームが無い
    expect(parseOutboundUrl('hooks.example.com', env())).toEqual({
      ok: false,
      reason: OutboundUrlRejection.unparsable,
    });
  });

  it('非本番のループバック http は受け付ける (ローカルのスタブ用)', () => {
    // 3 つの書き方すべて
    for (const candidate of [
      'http://127.0.0.1:4010/hook',
      'http://localhost:4010/hook',
      'http://[::1]:4010/hook',
    ]) {
      expect(parseOutboundUrl(candidate, env({ NODE_ENV: 'test' })).ok).toBe(true);
    }
  });

  it('本番ではループバックでも http を拒否する', () => {
    // 本番で平文を許すと署名鍵も本文も素で流れる
    expect(parseOutboundUrl('http://127.0.0.1:4010/hook', env({ NODE_ENV: 'production' }))).toEqual(
      { ok: false, reason: OutboundUrlRejection.insecure_scheme },
    );
  });

  it('ループバック以外の http は非本番でも拒否する', () => {
    // 外部ホストへの平文は設定ミス
    expect(parseOutboundUrl('http://hooks.example.com/x', env())).toEqual({
      ok: false,
      reason: OutboundUrlRejection.insecure_scheme,
    });
  });
});

describe('ガードレールの通知', () => {
  // 各テストでスタブを片付ける
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ログを黙らせる (設定ミスの検査で意図的にログが出るため)
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('設定された 2 つの宛先へ署名付きで POST する', async () => {
    // どちらも 204 を返す
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    // 送る
    const results = await notifyGuardrailIncident(PAYLOAD, env());
    // 2 件とも届いた
    expect(results.map((r) => r.status).sort()).toEqual(['delivered', 'delivered']);
    // 2 つの宛先へ送っている
    expect(calls.map((c) => c.url).sort()).toEqual([MAIL_URL, WEBHOOK_URL].sort());
    // 本文は payload をそのまま JSON にしたもの
    expect(calls[0]!.init.body).toBe(JSON.stringify(PAYLOAD));
    // 署名は本文の HMAC-SHA256 (受け手が同じ鍵で検証できる)
    const expected = createHmac('sha256', SECRET)
      .update(JSON.stringify(PAYLOAD), 'utf8')
      .digest('hex');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers[NOTIFY_SIGNATURE_HEADER]).toBe(`sha256=${expected}`);
  });

  it('リダイレクトを追わない (受け手が接続先を書き換えられない)', async () => {
    // 呼び出しを記録する
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    // 送る
    await notifyGuardrailIncident(PAYLOAD, env());
    // **redirect: 'manual'** を渡していること。追うと署名付きの本文が別ホストへ行く
    expect(calls[0]!.init.redirect).toBe('manual');
  });

  it('3xx は届いたことにしない (追わないので失敗)', async () => {
    // リダイレクト応答を返す
    stubFetch(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.test' } }),
    );
    // 送る
    const results = await notifyGuardrailIncident(PAYLOAD, env());
    // 2 件とも失敗
    expect(results.every((r) => r.status === 'failed')).toBe(true);
  });

  it('宛先が未設定なら送らない (異常ではない)', async () => {
    // 呼び出しを記録する
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    // どちらの宛先も空
    const results = await notifyGuardrailIncident(
      PAYLOAD,
      env({
        [NOTIFY_URL_ENV[NotifyChannel.webhook]]: '',
        [NOTIFY_URL_ENV[NotifyChannel.email]]: undefined,
      }),
    );
    // 1 度も送っていない
    expect(calls).toHaveLength(0);
    // 2 件とも「未設定」
    expect(results.every((r) => r.status === 'not_configured')).toBe(true);
  });

  it('署名鍵が無い・短すぎるなら送らない (fail-closed)', async () => {
    // 呼び出しを記録する
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    // 下限より 1 文字短い鍵
    const tooShort = 'a'.repeat(NOTIFY_SIGNING_SECRET_MIN_LENGTH - 1);
    // 未設定・空・短すぎの 3 通り
    for (const secret of [undefined, '', tooShort]) {
      // 送ろうとする
      const results = await notifyGuardrailIncident(
        PAYLOAD,
        env({ [NOTIFY_SIGNING_SECRET_ENV]: secret }),
      );
      // **署名できない通知は送らない** (受け手がなりすましと区別できないため)
      expect(results.every((r) => r.status === 'unsigned')).toBe(true);
    }
    // 1 度も送っていない
    expect(calls).toHaveLength(0);
  });

  it('宛先の形が受け付けられなければ送らない', async () => {
    // 呼び出しを記録する
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    // Webhook は平文の外部ホスト、メールは資格情報付き
    const results = await notifyGuardrailIncident(
      PAYLOAD,
      env({
        [NOTIFY_URL_ENV[NotifyChannel.webhook]]: 'http://hooks.example.com/x',
        [NOTIFY_URL_ENV[NotifyChannel.email]]: 'https://user:pass@mail.example.com/x',
      }),
    );
    // 1 度も送っていない
    expect(calls).toHaveLength(0);
    // 2 件とも宛先が拒否された
    expect(results.every((r) => r.status === 'rejected_target')).toBe(true);
  });

  it('受け手が落ちていても例外を外へ出さない (fail-open)', async () => {
    // fetch が例外を投げる
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    // **ここで throw すると、Webhook の受け手が落ちているあいだ「超過しても止まらない」状態になる**
    const results = await notifyGuardrailIncident(PAYLOAD, env());
    // 失敗として返るだけ
    expect(results.every((r) => r.status === 'failed')).toBe(true);
  });

  it('受け手が黙り込んでも時間切れで打ち切る', async () => {
    // 時間を偽装する
    vi.useFakeTimers();
    try {
      // 中断の合図を待つだけの fetch (実際の実装と同じく signal で中断される)
      stubFetch(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            // 中断されたら reject する (undici と同じ振る舞い)
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      );
      // 送り始める
      const pending = notifyGuardrailIncident(PAYLOAD, env());
      // 上限時間を進める
      await vi.advanceTimersByTimeAsync(NOTIFY_TIMEOUT_MS + 1);
      // 打ち切られて失敗として返る (発火の処理が受け手に引きずられない)
      expect((await pending).every((r) => r.status === 'failed')).toBe(true);
    } finally {
      // 必ず実時間へ戻す
      vi.useRealTimers();
    }
  });

  it('応答本文が大きくても読み切って捨てる (メモリを食わない)', async () => {
    // 上限を超える本文を返す
    stubFetch(() => new Response('x'.repeat(1_000_000), { status: 200 }));
    // 送る
    const results = await notifyGuardrailIncident(PAYLOAD, env());
    // 応答の中身は使わないので、2xx なら届いた扱い
    expect(results.every((r) => r.status === 'delivered')).toBe(true);
  });
});
