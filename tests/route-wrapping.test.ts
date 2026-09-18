// 本番の実行経路そのものを見張る検査。
//   (1) Route Handler が必ず route() を通ること — 通らない export は認証も認可もキャッシュ制御も無いまま公開される
//   (2) 公開される HTTP メソッドが契約 (openapi.yaml) に載っていること
//   (3) トークンの乱数が暗号学的乱数であること・秘密の比較が定数時間であること
// いずれも「本番コードを壊しても全テストが緑」だった穴を塞ぐ。
// (1) は**実際にモジュールを読み込んで印を見る** — ソースの綴りを見る形だと、`export { PUT }` のような
// 別の書き方・OPTIONS のような別のメソッド・v1 の外のディレクトリがすべて死角になる (実測で素通りした)
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { ALLOWED_ROUTE_FILE_NAME, findRouteFiles } from './lib/route-files';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { ROUTE_HANDLER_BRAND } from '@/lib/api/handler';

// App Router の入口 (この下にある route.ts はすべて配信される)
const APP_DIR = join(process.cwd(), 'src', 'app');
// 契約が受け持つ API の入口 (OpenAPI の servers.url に対応)
const API_DIR = join(APP_DIR, 'api', 'v1');
// Next.js が Route Handler として呼ぶ export 名 (5 つに絞ると HEAD / OPTIONS が死角になる)
const HTTP_METHOD_EXPORTS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
// 認証を通さないことが正しい経路 (理由付きの唯一の除外。キーは src/app からの相対パス)
const UNAUTHENTICATED_ROUTES: Record<string, string> = {
  'api/v1/health/route.ts': 'DB 到達性だけを返す公開エンドポイント (compose の healthcheck が使う)',
};

// パスの区切りを URL 向けに揃える
function toPosix(path: string): string {
  // Windows の区切りも '/' にする
  return path.split('\\').join('/');
}

// 集めた Route Handler (src/app 全体。api/v1 の外に置かれたものも捕まえる)
const routeFiles = findRouteFiles(APP_DIR).map((full) => ({
  full,
  // src/app からの相対パス (除外表のキーと突き合わせる)
  relativeToApp: toPosix(relative(APP_DIR, full)),
}));

// 契約 (openapi.yaml) を読む
const spec = parse(readFileSync(join(process.cwd(), 'openapi', 'openapi.yaml'), 'utf8')) as {
  paths: Record<string, Record<string, unknown>>;
};

describe('Route Handler の結線', () => {
  // 走査が壊れて 0 件になったら落とす (fail-closed)
  it('Route Handler を 1 つ以上見つけている', () => {
    // 見つけた数
    expect(routeFiles.length).toBeGreaterThan(0);
  });

  // 契約の外に生やした経路は、認可の網羅ガード (tests/api/rbac-endpoints.test.ts) の対象にもならない
  it('Route Handler は契約が受け持つ api/v1 の下にしか置かれていない', () => {
    for (const { full, relativeToApp } of routeFiles) {
      // api/v1 の下にあること
      expect(
        toPosix(relative(API_DIR, full)).startsWith('..'),
        `${relativeToApp} が api/v1 の外にある`,
      ).toBe(false);
    }
  });

  // 走査は route.tsx / route.js も拾うが、このリポジトリでは .ts だけを書く。
  // 綴りを 1 つに固定しておくと、将来 pageExtensions が増えても検査の前提が崩れない
  it('Route Handler の綴りは route.ts に統一されている', () => {
    for (const { full, relativeToApp } of routeFiles) {
      // ファイル名が唯一の綴りであること
      expect(basename(full), `${relativeToApp} は ${ALLOWED_ROUTE_FILE_NAME} で書く`).toBe(
        ALLOWED_ROUTE_FILE_NAME,
      );
    }
  });

  // 認証・認可・キャッシュ制御は route() が 1 か所で行う。素の export はその全部を素通りする
  it('HTTP メソッドの export はすべて route() が包んだ関数である', async () => {
    // 実際に印を確かめた数 (0 件なら走査が壊れている)
    let checked = 0;
    for (const { full, relativeToApp } of routeFiles) {
      // 公開エンドポイントは対象外 (理由は表に書く)
      if (relativeToApp in UNAUTHENTICATED_ROUTES) continue;
      // モジュールを実際に読み込む (綴りではなく値を見る)
      const routeModule: Record<string, unknown> = await import(pathToFileURL(full).href);
      for (const method of HTTP_METHOD_EXPORTS) {
        // その名前を export していなければ何もしない
        const exported = routeModule[method];
        if (exported === undefined) continue;
        // route() が包んだ印を持つこと
        checked += 1;
        expect(
          typeof exported === 'function' &&
            (exported as unknown as Record<symbol, unknown>)[ROUTE_HANDLER_BRAND] === true,
          `${relativeToApp} の ${method} が route() を通っていない`,
        ).toBe(true);
      }
    }
    // 1 つも見ていなければ走査が壊れている
    expect(checked).toBeGreaterThan(0);
  });

  // 契約に無いメソッドは、認可の網羅ガードの表にも載らないまま公開される
  it('公開している HTTP メソッドはすべて契約に載っている', async () => {
    for (const { full, relativeToApp } of routeFiles) {
      // ディレクトリ名から契約のパスへ戻す (例: agents/[agentId] → /agents/{agentId})
      const segments = toPosix(relative(API_DIR, full))
        .split('/')
        .slice(0, -1)
        .map((segment) => segment.replace(/^\[(.+)\]$/, '{$1}'));
      // 契約側のパス項目
      const declared = spec.paths[`/${segments.join('/')}`];
      // 契約に無いパスは別の検査 (tests/openapi.test.ts) が落とす
      if (!declared) continue;
      // モジュールを読み込む
      const routeModule: Record<string, unknown> = await import(pathToFileURL(full).href);
      for (const method of HTTP_METHOD_EXPORTS) {
        // export していないメソッドは対象外
        if (routeModule[method] === undefined) continue;
        // HEAD / OPTIONS は契約に書かない慣習なので、ここでは GET 等だけを見る
        if (method === 'HEAD' || method === 'OPTIONS') continue;
        // 契約に宣言があること
        expect(
          method.toLowerCase() in declared,
          `${relativeToApp} の ${method} が openapi.yaml に無い`,
        ).toBe(true);
      }
    }
  });
});

describe('秘密の生成と比較', () => {
  // トークン生成のソース
  const tokens = readFileSync(join(process.cwd(), 'src', 'lib', 'tokens.ts'), 'utf8');
  // 認証のソース (秘密を実際に比べる場所)
  const auth = readFileSync(join(process.cwd(), 'src', 'lib', 'api', 'auth.ts'), 'utf8');

  // 予測可能な乱数になると、発行済みの全トークン・API キーが推測できる (乗っ取りに直結)
  it('トークンの乱数は node:crypto の randomBytes から取る', () => {
    // node:crypto から randomBytes を読んでいること
    expect(/import\s+\{[^}]*\brandomBytes\b[^}]*\}\s+from\s+'node:crypto'/.test(tokens)).toBe(true);
    // 乱数の作成に使っていること
    expect(/randomBytes\(/.test(tokens)).toBe(true);
    // 擬似乱数を混ぜていないこと
    expect(/Math\.random/.test(tokens)).toBe(false);
  });

  // 早期終了の比較に戻すと、前方一致の長さが応答時間から漏れる
  it('secretsEqual は定数時間比較で実装されている', () => {
    // secretsEqual の本体を切り出す
    const body = /export function secretsEqual\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(tokens)?.[1];
    // 本体が読めること (書き方を変えたらここで気付く)
    expect(body, 'secretsEqual の定義が読めない').toBeDefined();
    // その中で定数時間比較を使っていること
    expect(body && /timingSafeEqual\(/.test(body)).toBe(true);
  });

  // 実装が定数時間でも、呼び出し側が === に戻れば同じこと (実測で全件緑のまま通った)
  it('プラットフォーム管理者トークンの照合は secretsEqual を通す', () => {
    // 照合関数の本体を切り出す
    const body = /function matchesPlatformAdminToken\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(auth)?.[1];
    // 本体が読めること
    expect(body, 'matchesPlatformAdminToken の定義が読めない').toBeDefined();
    // 定数時間比較のヘルパーを通していること
    expect(body && /secretsEqual\(/.test(body)).toBe(true);
    // 秘密を比べる書き方がヘルパー以外に無いこと。return 文だけを見る形だと、
    // 「secretsEqual の前に安い比較を足して早期終了する」退行 (前方一致の長さが応答時間から漏れる)
    // が素通りする (実測)。長さの下限検査 (< による比較) は設定ミスの検出なので対象外
    const forbidden = [
      '===',
      '!==',
      '.startsWith(',
      '.endsWith(',
      '.includes(',
      '.indexOf(',
      '.slice(',
      '.localeCompare(',
    ];
    for (const pattern of forbidden) {
      expect(body?.includes(pattern), `照合の中で ${pattern} を使っている`).toBe(false);
    }
  });
});
