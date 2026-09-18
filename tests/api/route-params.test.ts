// URL の動的セグメント (パスに現れる id) の検証。
// **この壊れ方は他の API テストからは見えない** — memory アダプタは「表に無い」だけなので不正な id でも
// 404 に見えるのに、本番 (prisma + PostgreSQL) では NUL を含む text が拒否されて 500 になる。
// 実測では本番ビルドに `GET /api/v1/agents/%00` を投げると 500 とスタックのログが積まれ、
// viewer ロールのトークンだけで何度でも繰り返せた (ADR-0006 の構造的な死角)。
// だから「本体へ渡す前に落ちること」を route() の層で直接固定する
import { describe, expect, it } from 'vitest';
import { route } from '@/lib/api/handler';
import { RESOURCE_ID_MAX_LENGTH } from '@/domain/resource-id';
import { call, seedEachTest } from './helpers';

// 2 テナント × 3 役割の seed (各テストの前に作り直す)
const seed = seedEachTest();

describe('動的セグメントの検証', () => {
  // 資源 id として受け付けない値 (どれも DB へ渡すと 500 になるか、id として意味を持たない)
  const rejected: [string, string][] = [
    ['NUL を含む (%00 で送れる)', String.fromCharCode(0)],
    ['制御文字を含む', `ab${String.fromCharCode(7)}cd`],
    ['空文字', ''],
    ['スラッシュを含む', 'a/b'],
    ['長すぎる', 'a'.repeat(RESOURCE_ID_MAX_LENGTH + 1)],
  ];

  it.each(rejected)('%s id は本体へ渡さず 404 にする', async (_label, agentId) => {
    // 本体が呼ばれたかどうかを記録する
    let called = false;
    // 本体は「呼ばれたら 200」を返すだけのハンドラ
    const handler = route<{ agentId: string }>(async () => {
      called = true;
      return Response.json({ ok: true });
    });
    // 認証は通る (viewer の正規のトークン) が、セグメントの形が不正
    const result = await call(handler, { token: seed.a.tokens.viewer, params: { agentId } });
    // 存在しない資源として 404 (形の不正を 500 にも 422 にもしない)
    expect(result.status).toBe(404);
    // 本体まで届いていない = アダプタにも DB にも渡っていない
    expect(called).toBe(false);
  });

  // **2 番目以降のセグメントも同じ表で試す。** 単一セグメントのケースだけだと「先頭のセグメントしか
  // 見ない」形へ退行しても全件緑で通り (実測: 317 件のまま変わらなかった)、実在する 2 セグメントのルート
  // `/users/{userId}/tokens/{tokenId}` でだけ 56 巡目の 500 が復活する
  it.each(rejected)(
    '2 番目のセグメントが %s でも本体へ渡さず 404 にする',
    async (_label, tokenId) => {
      // 本体が呼ばれたかどうかを記録する
      let called = false;
      // 2 セグメントを受けるハンドラ (実在するルートと同じ形)
      const handler = route<{ userId: string; tokenId: string }>(async () => {
        called = true;
        return Response.json({ ok: true });
      });
      // 先頭は正しい id で、2 番目だけが不正
      const result = await call(handler, {
        token: seed.a.tokens.admin,
        params: { userId: seed.a.users.admin.id, tokenId },
      });
      // 存在しない資源として 404
      expect(result.status).toBe(404);
      // 本体まで届いていない
      expect(called).toBe(false);
    },
  );

  it('配列で届くセグメント (catch-all) も本体へ渡さない (fail-closed)', async () => {
    // 本体が呼ばれたかどうかを記録する
    let called = false;
    // catch-all ルート (`[...slug]`) の params は配列で届く。Step1 には該当ルートが無いので
    // いまは到達しないが、「文字列でなければ拒否」という防御線を検出網に載せておく
    const handler = route<{ slug: string }>(async () => {
      called = true;
      return Response.json({ ok: true });
    });
    // 配列を渡す (型は文字列なので、実際に届く形を再現するため変換する)
    const result = await call(handler, {
      token: seed.a.tokens.viewer,
      params: { slug: ['a', 'b'] as unknown as string },
    });
    // 404 で止まり、本体まで届かない
    expect(result.status).toBe(404);
    expect(called).toBe(false);
  });

  it('正しい形の id は本体まで届く (検証が広すぎて正規の要求を落としていないこと)', async () => {
    // 本体は受け取った id をそのまま返す
    const handler = route<{ agentId: string }>(async ({ params }) =>
      Response.json({ agentId: params.agentId }),
    );
    // seed 済みエージェントの id (cuid 相当)
    const result = await call(handler, {
      token: seed.a.tokens.viewer,
      params: { agentId: seed.a.agent.id },
    });
    // 本体が動いている
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ agentId: seed.a.agent.id });
  });
});
