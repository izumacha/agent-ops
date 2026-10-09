// GET /metrics の認証と応答の形。
//
// **この経路は JSON を返さない唯一の API** なので、共通の `call()`（本文を JSON として読む）は
// 200 の検査に使えない。401 / 503 の本文は JSON なので、そこだけ `call()` を使う。
//
// **守っているのは専用の読み取りトークン**（`METRICS_TOKEN`）で、プラットフォーム管理者
// トークンでは読めない。あの資格情報はテナント作成（応答に新しいテナントの admin トークンの
// 平文が載る）とプラン変更も通るので、監視の収集エージェントへ配らないため（§9 最小権限）。
import { describe, expect, it, vi } from 'vitest';
import { GET as getMetrics } from '@/app/api/v1/metrics/route';
import {
  METRICS_TOKEN_MIN_LENGTH,
  NO_STORE_CACHE_CONTROL,
  PROMETHEUS_CONTENT_TYPE,
} from '@/lib/constants';
import { Role } from '@/domain/types';
import { COUNTERS, GAUGES, renderMetrics, resetMetricsForTesting } from '@/lib/metrics';
import { resetMetricsAuthForTesting } from '@/lib/api/metrics-auth';
import { resetThrottledLogsForTesting } from '@/lib/log';
import { captureLogOutlet, loggedEvents } from '../lib/log-lines';
import { METRICS_TOKEN, PLATFORM_TOKEN, call, seedEachTest } from './helpers';

// 2 テナント × 3 役割を seed する（役割ごとの 401 を見るため）
const seed = seedEachTest();

/**
 * メトリクスの経路をテキストとして呼ぶ。
 * @param token Bearer トークン（省略すると未認証）
 * @returns ステータス・本文のテキスト・応答ヘッダ
 */
async function fetchMetrics(
  token?: string,
): Promise<{ status: number; text: string; headers: Headers }> {
  // 認証ヘッダを組み立てる
  const headers = new Headers();
  if (token !== undefined) headers.set('authorization', `Bearer ${token}`);
  // ハンドラを直接呼ぶ（URL はダミー。この経路はクエリを見ない）
  const response = await getMetrics(new Request('http://test.local/api/v1/metrics', { headers }));
  // 本文はテキストのまま読む
  return { status: response.status, text: await response.text(), headers: response.headers };
}

describe('GET /metrics', () => {
  it('監視用トークンで Prometheus のテキストを受け取る', async () => {
    // 呼ぶ
    const result = await fetchMetrics(METRICS_TOKEN);
    expect(result.status).toBe(200);
    // 形式を名乗っている（スクレイプ側が解析器を選ぶ手掛かり）
    expect(result.headers.get('content-type')).toBe(PROMETHEUS_CONTENT_TYPE);
    // 宣言したカウンタがすべて現れる（名前の一覧はここへ書き写さず COUNTERS から導く）
    for (const name of Object.keys(COUNTERS)) expect(result.text).toContain(`# TYPE ${name} `);
    // **ゲージも同じ導出で照合する** — 名前を本体へ直書きしていた頃は、この 2 本だけが
    // どの検査からも見えず、名前を書き換えても全件緑だった
    for (const name of Object.keys(GAUGES)) expect(result.text).toContain(`# TYPE ${name} gauge`);
  });

  it('保存を禁じている（認証付きの運用情報なので中間のキャッシュに残さない）', async () => {
    // 包むラッパーが route() を通る応答と同じキャッシュ制御を付けている
    const result = await fetchMetrics(METRICS_TOKEN);
    expect(result.headers.get('cache-control')).toContain(NO_STORE_CACHE_CONTROL);
    // **Vary はちょうど 1 回だけ** — このルートが自分でも付けていた頃は、包む側と二重に
    // 掛かって `Vary: Authorization, Authorization` を返していた（実測）。
    // 付ける場所が 1 か所であることを、実際の応答で固定する
    expect(result.headers.get('vary')).toBe('Authorization, Cookie');
  });

  it('自分の応答も数える（結線が外れていれば増えない）', async () => {
    // 1 回呼ぶと、その応答が `agentops_http_responses_total` に乗る
    await fetchMetrics(METRICS_TOKEN);
    // 2 回目の本文に 1 回目の分が現れる
    const result = await fetchMetrics(METRICS_TOKEN);
    expect(result.text).toMatch(/agentops_http_responses_total\{method="GET",status="200"\} [1-9]/);
  });

  it('拒否した応答も数える（401 の山が外から読めるようにする）', async () => {
    // 合わないトークンで 1 回叩く
    expect((await fetchMetrics('wrong-token-0123456789abcdefghijklmn')).status).toBe(401);
    // 正しいトークンで読むと、その 401 が系列に乗っている
    const result = await fetchMetrics(METRICS_TOKEN);
    expect(result.text).toMatch(/agentops_http_responses_total\{method="GET",status="401"\} [1-9]/);
  });

  it('プラットフォーム管理者トークンでは読めない（最小権限）', async () => {
    // テナント作成・プラン変更ができる資格情報では通さない
    const result = await call(getMetrics, { token: PLATFORM_TOKEN });
    expect(result.status).toBe(401);
  });

  it.each([Role.admin, Role.operator, Role.viewer])(
    'テナント内の %s は 401（テナント境界の外側の数字なので見せない）',
    async (role) => {
      // テナントのユーザートークンで呼ぶ
      const result = await call(getMetrics, { token: seed.a.tokens[role] });
      expect(result.status).toBe(401);
    },
  );

  it('トークン無しは 401', async () => {
    // 認証を通らない（他テナントの活動量が読める経路なので、既定で閉じている）
    const result = await call(getMetrics, {});
    expect(result.status).toBe(401);
  });

  it('METRICS_TOKEN が未設定なら 503 で、警告は 1 度だけ出す', async () => {
    // 警告の「出したか」を忘れる（テストの独立性のため）
    resetMetricsAuthForTesting();
    // 設定を消す（このテストの中だけ）
    vi.stubEnv('METRICS_TOKEN', '');
    // 出口を捕まえる
    const outlet = captureLogOutlet();
    try {
      // 正しい値を知っていても通れない
      expect((await fetchMetrics(METRICS_TOKEN)).status).toBe(503);
      // 未認証でも同じ 503。**「設定済みかどうかを隠す」という意味ではない** —
      // 503 と 401 の違いから設定の有無は読める（`API_MESSAGES.metricsNotConfigured` の
      // コメントがその割り切りの正本）。ここで見ているのは「未認証でも通らない」ことだけ
      expect((await fetchMetrics()).status).toBe(503);
      // **1 行は出る** — ここだけ記録していなかったので、いちばん起きやすい設定漏れが
      // 唯一どの出口にも現れなかった（`{status="503"}` は `/metrics` 経由でしか読めず、
      // その `/metrics` 自身が 503 なので到達できない）。**設定の通知なので 1 度だけ**
      expect(loggedEvents(outlet.calls())).toEqual(['metrics.token_not_configured']);
    } finally {
      outlet.restore();
      resetMetricsAuthForTesting();
    }
  });

  // **401 を読むのは系列ではなくログ**（経路を示すラベルが無いので他の 401 と区別できず、
  // サーバーレスでは引きに行く収集そのものが成り立たない＝`docs/deploy.md`）
  it('トークンが合わなかったことをログに残す（収集側の設定ミスを無言にしない）', async () => {
    // 間引きの記憶を忘れる（前のテストが 1 本出していると窓の中になる）
    resetThrottledLogsForTesting();
    // 出口を捕まえる（深刻度でメソッドが分かれるので両方）
    const outlet = captureLogOutlet();
    try {
      // 違う値で 2 回叩く（どちらも 401）
      expect((await fetchMetrics('x'.repeat(METRICS_TOKEN_MIN_LENGTH))).status).toBe(401);
      expect((await fetchMetrics('y'.repeat(METRICS_TOKEN_MIN_LENGTH))).status).toBe(401);
      // **行は 2 の冪の回だけ**（1 件目と 2 件目は冪なのでどちらも出る）。
      // 10 件なら 4 本、1 万件なら 14 本に収まり、最後の行の `occurrence` が規模を表す
      expect(loggedEvents(outlet.calls())).toEqual([
        'metrics.token_rejected',
        'metrics.token_rejected',
      ]);
    } finally {
      outlet.restore();
    }
  });

  it.each([
    ['ヘッダが無い', undefined],
    ['Bearer でない方式', 'Basic abcdef'],
  ])(
    '%s 要求も 401 をログに残す（いちばん起きやすい設定ミスを無言にしない）',
    async (_label, authorization) => {
      // 間引きの記憶を忘れる
      resetThrottledLogsForTesting();
      const outlet = captureLogOutlet();
      try {
        // ヘッダを組み立てて直接呼ぶ（`fetchMetrics` は Bearer 形式しか作れない）
        const headers = new Headers();
        if (authorization !== undefined) headers.set('authorization', authorization);
        const response = await getMetrics(
          new Request('http://test.local/api/v1/metrics', { headers }),
        );
        // どちらも 401
        expect(response.status).toBe(401);
        // **1 行出る** — 以前はトークンを取り出す側が先に投げていたので、
        // 収集側が `bearer_token` を書き忘れた／基本認証にした場合だけログが 0 行だった（実測）
        expect(loggedEvents(outlet.calls())).toEqual(['metrics.token_rejected']);
      } finally {
        outlet.restore();
      }
    },
  );

  it('間引いた回も数える（率は agentops_log_events_total に残る）', async () => {
    // カウンタと間引きの記憶を空にする
    resetMetricsForTesting();
    resetThrottledLogsForTesting();
    const outlet = captureLogOutlet();
    try {
      // 3 回断られる
      for (let i = 0; i < 3; i += 1) {
        expect((await fetchMetrics('z'.repeat(METRICS_TOKEN_MIN_LENGTH))).status).toBe(401);
      }
      // 3 件なら行は 2 本（1 件目・2 件目。3 件目は冪でないので数えるだけ）
      expect(loggedEvents(outlet.calls())).toEqual([
        'metrics.token_rejected',
        'metrics.token_rejected',
      ]);
    } finally {
      outlet.restore();
    }
    // **数えるのは毎回**（間引きが率を消さないこと）
    expect(renderMetrics(new Date())).toContain(
      'agentops_log_events_total{event="metrics.token_rejected",level="warn"} 3',
    );
  });

  it('METRICS_TOKEN が短すぎれば 503 で、警告は 1 度だけ出す', async () => {
    // 警告の「出したか」を忘れる（テストの独立性のため）
    resetMetricsAuthForTesting();
    // 下限より 1 文字短い値を設定する
    const tooShort = 'a'.repeat(METRICS_TOKEN_MIN_LENGTH - 1);
    vi.stubEnv('METRICS_TOKEN', tooShort);
    // ログを捕まえる
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // 2 回叩く（どちらも 503）
      expect((await fetchMetrics(tooShort)).status).toBe(503);
      expect((await fetchMetrics(tooShort)).status).toBe(503);
      // 警告は 1 件だけ（未認証の総当たりでエラーログを埋められないようにしている）
      expect(loggedEvents(spy.mock.calls)).toEqual(['metrics.token_too_short']);
    } finally {
      // 元へ戻す
      spy.mockRestore();
      resetMetricsAuthForTesting();
    }
  });

  it('resetMetricsAuthForTesting は本番では呼べない（警告 1 度だけの抑止を解除させない）', () => {
    // 本番のふりをする
    vi.stubEnv('NODE_ENV', 'production');
    try {
      // 呼ぶと投げる（`resetMetricsForTesting` / `setReposForTesting` と同じ扱い）。
      // **この 1 本が無いとガードの 3 行を消しても全件緑で通った**（実測）— 消えると本番で
      // 「短すぎる設定の警告」を毎リクエスト出せるようになり、未認証の総当たりで
      // エラーログを埋められる状態（上のテストが固定している抑止）へ戻る
      expect(() => resetMetricsAuthForTesting()).toThrow(/本番/);
    } finally {
      // **このテストの中で戻す** — このファイルは `seedEachTest()` の後始末が
      // `setReposForTesting` を呼ぶので、`NODE_ENV` を本番のまま抜けるとその後始末が
      // 同じ種類のガードで投げ、無関係なテストまで赤くなる（実測で 2 件落ちた）
      vi.unstubAllEnvs();
    }
  });

  it('下限ちょうどの長さなら通る（境界）', async () => {
    // 下限と同じ長さの値を設定する
    const atLimit = 'b'.repeat(METRICS_TOKEN_MIN_LENGTH);
    vi.stubEnv('METRICS_TOKEN', atLimit);
    // その値で読める
    expect((await fetchMetrics(atLimit)).status).toBe(200);
  });
});
