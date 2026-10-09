// /api/v1/health: 未認証で叩ける唯一の経路。DB 障害時に内部詳細を外へ出さないことを固定する
import { afterEach, describe, expect, it, vi } from 'vitest';

// prisma の singleton を差し替える (実 DB へつながずに成功・失敗の両経路を通す)。
// vi.mock の工場は巻き上げられるので、参照する関数は vi.hoisted で先に作る
const { queryRaw } = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { $queryRaw: queryRaw } }));

// 差し替えた後で読む (静的 import でも vi.mock が先に効く)
import { GET } from '@/app/api/v1/health/route';
import { parseLoggedLine, renderLoggedLine } from '../lib/log-lines';
import { renderMetrics, resetMetricsForTesting } from '@/lib/metrics';
import { NO_STORE_CACHE_CONTROL } from '@/lib/constants';

/**
 * このルートへ渡す要求を作る。
 * **包む側 (`withResponseCount`) がメソッドを要求から読む**ので、ハンドラを直接呼ぶときも
 * 要求を渡す必要がある（文字列を書かないので `HEAD` も正しいラベルで数えられる）。
 * @param method HTTP メソッド（既定は GET）
 * @returns 要求
 */
function healthRequest(method = 'GET'): Request {
  // URL はダミー（この経路はクエリを見ない）
  return new Request('http://test.local/api/v1/health', { method });
}

// 各テストの後でモックの記録を消す
afterEach(() => {
  vi.restoreAllMocks();
  queryRaw.mockReset();
});

describe('GET /health', () => {
  it('DB に到達できれば 200 で ok:true を返す', async () => {
    // SELECT 1 が成功する
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    // ハンドラを直接呼ぶ
    const response = await GET(healthRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, db: 'up' });
    // **包む側 (`withResponseCount`) がキャッシュ制御を付けているか見る**
    // (付いていないと前段のキャッシュ層が DB 障害中も古い ok:true を配り、監視が沈黙する)。
    // このルートは `route()` を通らないが、キャッシュ制御を決めるのは全ルート共通の 1 か所
    expect(response.headers.get('cache-control')).toBe(NO_STORE_CACHE_CONTROL);
    // Vary はちょうど 1 回 (自分でも付けていた経路は二重に並んでいた＝実測)
    expect(response.headers.get('vary')).toBe('Authorization, Cookie');
  });

  it('DB 障害時は 503 で、応答に内部詳細を 1 文字も含まない (サーバログにだけ残す)', async () => {
    // 接続情報を含む、いかにもドライバが投げそうなエラー
    const detail = 'connect ECONNREFUSED postgresql://postgres:s3cret@db-host:5432/agent_ops';
    queryRaw.mockRejectedValue(new Error(detail));
    // ログは記録だけして端末へ出さない
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    // ハンドラを直接呼ぶ
    const response = await GET(healthRequest());
    expect(response.status).toBe(503);
    // 失敗側にも同じく付いていること
    expect(response.headers.get('cache-control')).toBe(NO_STORE_CACHE_CONTROL);
    // 本文は「DB が落ちている」ことだけ (項目を足す変更もここで落ちる)
    const body = await response.json();
    expect(body).toEqual({ ok: false, db: 'down' });
    // 内部詳細が応答に混ざっていないこと (項目名を変えて足す形も、本文全体を文字列にして見れば捕まる)
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(body)).not.toContain('s3cret');
    // 詳細はサーバログには残っていること (黙って握り潰していないこと。§6)
    expect(errorLog).toHaveBeenCalledTimes(1);
    // **ログにも message は出さない。** ドライバの接続失敗は message に DSN
    // (利用者名・パスワード込み) をそのまま埋めるので、素で出すと接続情報が
    // コンテナログへ流れる。しかも compose の healthcheck が 10 秒ごとに叩くため
    // 障害中は同じ 1 行が積まれ続ける。route() が通る経路と同じ describeError に
    // 通し、種類 (name / code) と発生箇所だけを残す
    const logged = renderLoggedLine(errorLog.mock.calls[0]);
    expect(logged).not.toContain('s3cret');
    expect(logged).not.toContain('postgresql://');
    expect(logged).not.toContain('db-host');
    // 何が起きたかは分かること (握り潰しではない)。**文言ではなく出来事の識別子で照合する**
    // （文言は推敲で変わるが、識別子は警報の条件そのものなので変えたら気付く必要がある）
    const line = parseLoggedLine(errorLog.mock.calls[0]);
    expect(line.event).toBe('health.db_unreachable');
    expect(line.error).toMatchObject({ name: 'Error' });
  });

  // **この経路も応答を数える**（ADR-0014）。`route()` を通らないので、数える結線が外れると
  // メトリクスに 1 件も現れない。compose の healthcheck が 10 秒ごとに叩くため、
  // 503 の系列は「DB 障害がどれだけ続いたか」をそのまま表す
  it.each([
    { label: '成功', ready: true, status: 200 },
    { label: '失敗', ready: false, status: 503 },
  ])('$label した応答も数える', async ({ ready, status }) => {
    // カウンタを空にしてから 1 回だけ叩く
    resetMetricsForTesting();
    if (ready) queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    else queryRaw.mockRejectedValue(new Error('boom'));
    // 失敗側はログを端末へ出さない
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // 呼ぶ
    expect((await GET(healthRequest())).status).toBe(status);
    // その応答が系列に 1 件乗っている
    expect(renderMetrics(new Date())).toContain(
      `agentops_http_responses_total{method="GET",status="${status}"} 1`,
    );
  });
});
