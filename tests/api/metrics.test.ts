// GET /metrics の認可と応答の形。
//
// **この経路は JSON を返さない唯一の API** なので、共通の `call()`（本文を JSON として読む）は
// 200 の検査に使えない。401 / 403 の本文は JSON なので、そこだけ `call()` を使う。
import { describe, expect, it } from 'vitest';
import { GET as getMetrics } from '@/app/api/v1/metrics/route';
import { PROMETHEUS_CONTENT_TYPE, NO_STORE_CACHE_CONTROL } from '@/lib/constants';
import { Role } from '@/domain/types';
import { COUNTERS } from '@/lib/metrics';
import { PLATFORM_TOKEN, call, seedEachTest } from './helpers';

// 2 テナント × 3 役割を seed する（役割ごとの 403 を見るため）
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
  const response = await getMetrics(new Request('http://test.local/api/v1/metrics', { headers }), {
    params: Promise.resolve({}),
  });
  // 本文はテキストのまま読む
  return { status: response.status, text: await response.text(), headers: response.headers };
}

describe('GET /metrics', () => {
  it('プラットフォーム管理者は Prometheus のテキストを受け取る', async () => {
    // 呼ぶ
    const result = await fetchMetrics(PLATFORM_TOKEN);
    expect(result.status).toBe(200);
    // 形式を名乗っている（スクレイプ側が解析器を選ぶ手掛かり）
    expect(result.headers.get('content-type')).toBe(PROMETHEUS_CONTENT_TYPE);
    // 宣言したカウンタがすべて現れる（名前の一覧はここへ書き写さず COUNTERS から導く）
    for (const name of Object.keys(COUNTERS)) expect(result.text).toContain(`# TYPE ${name} `);
  });

  it('保存を禁じている（route() が付けるキャッシュ制御がテキスト応答にも効く）', async () => {
    // 数字は運用情報なので中間のキャッシュに残さない
    const result = await fetchMetrics(PLATFORM_TOKEN);
    expect(result.headers.get('cache-control')).toContain(NO_STORE_CACHE_CONTROL);
  });

  it('自分の応答も数える（結線が外れていれば増えない）', async () => {
    // 1 回呼ぶと、その応答が `agentops_http_responses_total` に乗る
    await fetchMetrics(PLATFORM_TOKEN);
    // 2 回目の本文に 1 回目の分が現れる（route() の中で数えているので、この経路も対象）
    const result = await fetchMetrics(PLATFORM_TOKEN);
    expect(result.text).toMatch(/agentops_http_responses_total\{method="GET",status="200"\} [1-9]/);
  });

  it.each([Role.admin, Role.operator, Role.viewer])(
    'テナント内の %s は 403（テナント境界の外側の数字なので見せない）',
    async (role) => {
      // テナントのユーザートークンで呼ぶ
      const result = await call(getMetrics, { token: seed.a.tokens[role] });
      expect(result.status).toBe(403);
    },
  );

  it('トークン無しは 401', async () => {
    // 認証を通らない（他テナントの活動量が読める経路なので、既定で閉じている）
    const result = await call(getMetrics, {});
    expect(result.status).toBe(401);
  });
});
