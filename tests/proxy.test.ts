// 入口の proxy (src/proxy.ts)。Next.js 本体が URL を解釈する前に「読めない要求」を落とす。
//
// **この経路は API テストからは見えない**: `tests/api/*` は Route Handler を直接呼ぶので、
// Next.js が `params` を組み立てるときに `decodeURIComponent` が投げる経路をそもそも通らない。
// 実測では本番ビルドに `GET /api/v1/agents/%ff` を**認証ヘッダ無しで**投げると、動的セグメントを持つ
// 全ルートが素の `Internal Server Error` (500) を返した (エラー契約 {status, message} ですらない)。
// 資格情報なしで 5xx を無制限に作れる状態は、5xx 率で監視やサーキットブレーカを組んだ配備で
// そのまま「障害の捏造」になるため、入口で 404 にしている
import { describe, expect, it } from 'vitest';
import { dirname, join, relative, sep } from 'node:path';
import { getDefaultHighWaterMark } from 'node:stream';
import type { NextRequest } from 'next/server';
import { config, proxy } from '@/proxy';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { NO_STORE_CACHE_CONTROL } from '@/lib/constants';
import {
  ENTRY_MAX_BODY_BYTES,
  JSON_BODY_MAX_BYTES,
  MAX_SOCKET_READ_BYTES,
} from '@/lib/body-limits';
import nextConfig from '../next.config';
import { findRouteFiles } from './lib/route-files';

// App Router の入口 (この下の route.* がそのまま URL になる)
const APP_DIR = join(process.cwd(), 'src', 'app');

// 実在する全ルートの代表 URL を導出する。**サンプルを手で並べない** — 実測では matcher の除外へ
// `|api/v1/users` を 1 つ足すだけで `/api/v1/users/%ff` が未認証のまま素の 500 へ戻るのに、
// 検査が 3 本のサンプルしか当てていなかったため全件緑のまま通った (テスト件数も不変)
const ROUTE_PATHS = findRouteFiles(APP_DIR).map((full) => {
  // src/app からの相対ディレクトリをパスの区切りへ揃える
  const segments = relative(APP_DIR, dirname(full)).split(sep);
  // ルートグループ `(name)` は URL に出ない。動的セグメントは代表値に置き換える
  const path = segments
    .filter((segment) => segment !== '' && !/^\(.*\)$/.test(segment))
    .map((segment) => segment.replace(/^\[\.{3}(.+)\]$/, 'sample').replace(/^\[(.+)\]$/, 'sample'))
    .join('/');
  // 先頭のスラッシュを付ける (src/app 直下なら '/')
  return `/${path}`;
});

// Request を proxy が受け取る形として渡す (proxy は url とメソッドしか見ない)
function request(url: string, method = 'GET'): NextRequest {
  // 実体は素の Request で足りる
  return new Request(url, { method }) as unknown as NextRequest;
}

// 入口のガードを掛けるメソッド。**GET だけで試さない** — 実測では判定を
// `request.method === 'GET' && !isDecodablePath(...)` に絞る 1 行の変異が全件緑のまま通り
// (テスト件数も 337 のまま変わらず)、本番では PATCH / DELETE / POST / OPTIONS の
// `/api/v1/agents/%ff` が未認証のまま素の 500 へ戻った。しかもその 500 はアプリのログに
// 1 行も出ない (Next.js 本体がアプリへ入る前に投げるため)。
// 「CORS の preflight だけ先に通す」といったもっともらしい差分でも同じ穴が開く
const METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

describe('入口の proxy', () => {
  // percent-decode に失敗するパス (どれも Next.js 本体へ渡すと 500 になる)
  const undecodable = [
    ['不正なバイト列', 'http://test.local/api/v1/agents/%ff'],
    ['符号化が途中で切れている', 'http://test.local/api/v1/agents/%'],
    ['16 進でない', 'http://test.local/api/v1/agents/%zz'],
    ['不正な UTF-8 列', 'http://test.local/api/v1/users/%c0%80/tokens/abc'],
  ] as const;

  // 壊れた URL × メソッドの直積で試す (ガードがメソッドに依らないことを固定する)
  const undecodableByMethod = undecodable.flatMap(([label, url]) =>
    METHODS.map((method) => [label, url, method] as const),
  );

  it.each(undecodableByMethod)(
    '%s パスは %#: 404 で返す (500 にしない)',
    async (_label, url, method) => {
      // 入口で止める
      const response = proxy(request(url, method));
      // 存在しない資源として 404
      expect(response.status, `${method} ${url}`).toBe(HTTP_STATUS.NOT_FOUND);
      // 応答の形は API のエラー契約に揃える (素の Internal Server Error を返さない)
      expect(response.headers.get('content-type')).toContain('application/json');
      // キャッシュ制御も route() の応答と同じ規律に揃える (この経路だけ外れていると気付けない)
      expect(response.headers.get('cache-control')).toBe(NO_STORE_CACHE_CONTROL);
      expect(response.headers.get('vary')).toContain('Authorization');
      // HEAD の応答は本文を持たないので、本文の形は本文を返すメソッドでだけ確かめる
      if (method !== 'HEAD') {
        await expect(response.json()).resolves.toMatchObject({ status: HTTP_STATUS.NOT_FOUND });
      }
    },
  );

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

  it('実在する全ルートが matcher の対象に入っている', () => {
    // ルートを 1 つも導出できなければ走査が壊れている (fail-closed)
    expect(ROUTE_PATHS.length, 'src/app から Route Handler を導出できない').toBeGreaterThan(0);
    // matcher は Next.js が解釈する文字列。ここでは同じ形の正規表現として当てて範囲だけを確かめる
    // (Next.js 本体の解釈と完全に同じではないが、「1 ルートだけ外す」ような変更は捕まえられる)
    const matcher = new RegExp(`^${config.matcher}$`);
    // 実在するルートはすべて対象 (壊れたセグメントを付けた形でも同じ)
    for (const path of [...ROUTE_PATHS, '/']) {
      expect(matcher.test(path), `${path} が matcher の対象外`).toBe(true);
      expect(matcher.test(`${path}/%ff`), `${path}/%ff が matcher の対象外`).toBe(true);
    }
    // 静的アセットは対象外
    expect(matcher.test('/_next/static/chunk.js')).toBe(false);
  });

  it('matcher の除外が実在するルートを覆っていない', () => {
    // 除外は否定先読みの中に `|` 区切りで書く
    const exclusions = /\(\?!([^)]*)\)/.exec(config.matcher)?.[1]?.split('|') ?? [];
    // 1 つも読めなければ走査が壊れている (fail-closed)
    expect(exclusions.length, 'matcher の除外を読み取れない').toBeGreaterThan(0);
    // どの除外も、実在するルートの前置詞になっていないこと。
    // **この形なら除外の綴りを写さずに済む** — 表を持つと、表ごと書き換える変異が素通りする
    for (const exclusion of exclusions) {
      for (const path of ROUTE_PATHS) {
        expect(
          path === `/${exclusion}` || path.startsWith(`/${exclusion}/`),
          `除外 ${exclusion} が実在するルート ${path} を入口から外している`,
        ).toBe(false);
      }
    }
  });

  it('復号できるパスは短絡せず素通しする (未知のパスも含む)', () => {
    // 実在するルートに加えて、ルートが無いパスも試す。**未知のパスを入れるのが要点** —
    // 実測では `/__diag` のような独自の短絡応答 (認証も認可も通らない JSON を返す経路) を
    // proxy に足しても全件緑のまま通った
    for (const path of [...ROUTE_PATHS, '/', '/__diag', '/api/v1/unknown', '/anything']) {
      // 素通しの応答 (NextResponse.next())
      const response = proxy(request(`http://test.local${path}`));
      // 「次へ渡す」印が付いていること = 自前の応答を返していない
      expect(response.headers.get('x-middleware-next'), `${path} で短絡している`).toBe('1');
    }
  });

  it('リクエストヘッダを書き換えない (下流へ資格情報を注入しない)', () => {
    // クライアントが任意のヘッダを付けて送ってくる状況
    const withHeader = new Request('http://test.local/api/v1/agents', {
      headers: { 'x-real-token': 'attacker-supplied' },
    }) as unknown as NextRequest;
    // 素通しする
    const response = proxy(withHeader);
    // `NextResponse.next({ request: { headers } })` でヘッダを差し替えるとこの印が付く。
    // 実測では、クライアント指定の値を Authorization として下流へ注入する変異が全件緑で通った
    expect(response.headers.get('x-middleware-override-headers')).toBeNull();
  });
});

describe('入口でバッファする本文の上限', () => {
  it('next.config.ts の値はアプリの本文上限から導出する (数値を書き写さない)', () => {
    // 設定に入っているのは導出した定数そのもの
    expect(nextConfig.experimental?.proxyClientMaxBodySize).toBe(ENTRY_MAX_BODY_BYTES);
  });

  it('入口の上限はアプリの上限より大きい (413 の経路を壊さない)', () => {
    // 入口がちょうど同じ値だと、上限超過の本文が「ちょうど上限」へ切り詰められて 413 を返せなくなる
    expect(ENTRY_MAX_BODY_BYTES).toBeGreaterThan(JSON_BODY_MAX_BYTES);
  });

  // **余白の検査は Node から実測した値を基準にする。** `MAX_SOCKET_READ_BYTES` は「Node の既定
  // highWaterMark」という外部の事実の写しなので、それを基準に余白を比べると
  // `ENTRY - JSON >= MAX_SOCKET_READ` が定義上 `X >= X` の恒真式になり、定数を 1 KiB へ縮める変異が
  // 全件緑で通った (実測: 件数も 368 のまま不変なのに、本番では切り詰めが「別の妥当な JSON」として
  // 受理された)。基準を `node:stream` から取れば、写しが事実からずれた時点で落ちる
  const socketReadBytes = getDefaultHighWaterMark(false);

  it('MAX_SOCKET_READ_BYTES が Node の実際の読み取り単位を下回らない', () => {
    // 写しが事実より小さいと、下の余白の検査ごと緩む
    expect(MAX_SOCKET_READ_BYTES).toBeGreaterThanOrEqual(socketReadBytes);
  });

  it('入口の余裕は 1 回のソケット読み取り以上ある (切り詰めが「別の妥当な JSON」に化けない)', () => {
    // Next.js は上限を跨いだかたまりを丸ごと捨てるので、余裕が 1 回の読み取りに満たないと
    // 切り詰め後の長さがアプリの上限ちょうどに着地でき、413 を通り抜ける
    expect(ENTRY_MAX_BODY_BYTES - JSON_BODY_MAX_BYTES).toBeGreaterThanOrEqual(socketReadBytes);
  });

  it('入口の余裕は 1 回のソケット読み取りの 2 倍以内 (未認証に握らせるヒープを小さく保つ)', () => {
    // **下限だけでは足りない。** 余白をいくら膨らませても下限の検査は通るので、余白の 1 行を
    // 既定 (10 MiB) 相当へ戻す変異が全件緑のまま通った (実測値は src/lib/body-limits.ts に記録)。
    // **上限も読み取り単位を基準にする** — アプリの本文上限の倍数で書くと、本文上限を下げたときに
    // 下限と矛盾して「どんな値でも緑にできない」状態になる (上下とも境界ちょうどのため)
    expect(ENTRY_MAX_BODY_BYTES - JSON_BODY_MAX_BYTES).toBeLessThanOrEqual(socketReadBytes * 2);
  });
});
