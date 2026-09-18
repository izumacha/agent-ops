// /api/v1/health: 未認証で叩ける唯一の経路。DB 障害時に内部詳細を外へ出さないことを固定する
import { afterEach, describe, expect, it, vi } from 'vitest';

// prisma の singleton を差し替える (実 DB へつながずに成功・失敗の両経路を通す)。
// vi.mock の工場は巻き上げられるので、参照する関数は vi.hoisted で先に作る
const { queryRaw } = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { $queryRaw: queryRaw } }));

// 差し替えた後で読む (静的 import でも vi.mock が先に効く)
import { GET } from '@/app/api/v1/health/route';

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
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, db: 'up' });
  });

  it('DB 障害時は 503 で、応答に内部詳細を 1 文字も含まない (サーバログにだけ残す)', async () => {
    // 接続情報を含む、いかにもドライバが投げそうなエラー
    const detail = 'connect ECONNREFUSED postgresql://postgres:s3cret@db-host:5432/agent_ops';
    queryRaw.mockRejectedValue(new Error(detail));
    // ログは記録だけして端末へ出さない
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    // ハンドラを直接呼ぶ
    const response = await GET();
    expect(response.status).toBe(503);
    // 本文は「DB が落ちている」ことだけ (項目を足す変更もここで落ちる)
    const body = await response.json();
    expect(body).toEqual({ ok: false, db: 'down' });
    // 内部詳細が応答に混ざっていないこと (項目名を変えて足す形も、本文全体を文字列にして見れば捕まる)
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(body)).not.toContain('s3cret');
    // 詳細はサーバログには残っていること (黙って握り潰していないこと。§6)
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errorLog.mock.calls[0])).toContain('ECONNREFUSED');
  });
});
