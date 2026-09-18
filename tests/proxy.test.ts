// 入口の proxy (src/proxy.ts)。Next.js 本体が URL を解釈する前に「読めない要求」を落とす。
//
// **この経路は API テストからは見えない**: `tests/api/*` は Route Handler を直接呼ぶので、
// Next.js が `params` を組み立てるときに `decodeURIComponent` が投げる経路をそもそも通らない。
// 実測では本番ビルドに `GET /api/v1/agents/%ff` を**認証ヘッダ無しで**投げると、動的セグメントを持つ
// 全ルートが素の `Internal Server Error` (500) を返した (エラー契約 {status, message} ですらない)。
// 資格情報なしで 5xx を無制限に作れる状態は、5xx 率で監視やサーキットブレーカを組んだ配備で
// そのまま「障害の捏造」になるため、入口で 404 にしている
import { describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { config, proxy } from '@/proxy';
import { HTTP_STATUS } from '@/lib/api/http-status';

// Request を proxy が受け取る形として渡す (proxy はこのテストで使う url しか見ない)
function request(url: string): NextRequest {
  // 実体は素の Request で足りる
  return new Request(url) as unknown as NextRequest;
}

describe('入口の proxy', () => {
  // percent-decode に失敗するパス (どれも Next.js 本体へ渡すと 500 になる)
  const undecodable = [
    ['不正なバイト列', 'http://test.local/api/v1/agents/%ff'],
    ['符号化が途中で切れている', 'http://test.local/api/v1/agents/%'],
    ['16 進でない', 'http://test.local/api/v1/agents/%zz'],
    ['不正な UTF-8 列', 'http://test.local/api/v1/users/%c0%80/tokens/abc'],
  ] as const;

  it.each(undecodable)('%s パスは 404 で返す (500 にしない)', async (_label, url) => {
    // 入口で止める
    const response = proxy(request(url));
    // 存在しない資源として 404
    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    // 応答の形は API のエラー契約に揃える (素の Internal Server Error を返さない)
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toMatchObject({ status: HTTP_STATUS.NOT_FOUND });
  });

  it.each([
    ['API のパス', 'http://test.local/api/v1/agents'],
    ['符号化された日本語', 'http://test.local/api/v1/agents/%E3%81%82'],
    ['トップページ', 'http://test.local/'],
  ])('%s はそのまま先へ渡す (正規の要求を落とさない)', (_label, url) => {
    // 素通しすること
    const response = proxy(request(url));
    // NextResponse.next() は「次へ渡す」印を付けた 200 を返す
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('API のパスが matcher の対象に入っている (静的アセットだけを外す)', () => {
    // matcher は Next.js が解釈する文字列。ここでは同じ形の正規表現として当てて範囲だけを確かめる
    // (Next.js 本体の解釈と完全に同じではないが、「/admin だけに狭める」ような変更は捕まえられる)
    const matcher = new RegExp(`^${config.matcher}$`);
    // API と画面は対象
    expect(matcher.test('/api/v1/agents/%ff')).toBe(true);
    expect(matcher.test('/')).toBe(true);
    // 静的アセットは対象外
    expect(matcher.test('/_next/static/chunk.js')).toBe(false);
  });
});
