// 本番の実行経路そのものを見張る検査。
//   (1) Route Handler が必ず route() を通ること — 通らない export は認証も認可もキャッシュ制御も無いまま公開される
//   (2) 公開される HTTP メソッドが契約 (openapi.yaml) に載っていること
//   (3) トークンの乱数が暗号学的乱数であること・秘密の比較が定数時間であること
// いずれも「本番コードを壊しても全テストが緑」だった穴を塞ぐ。
// (1) は**実際にモジュールを読み込んで印を見る** — ソースの綴りを見る形だと、`export { PUT }` のような
// 別の書き方・OPTIONS のような別のメソッド・v1 の外のディレクトリがすべて死角になる (実測で素通りした)
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { ALLOWED_ROUTE_FILE_NAME, findRouteFiles, PAGE_EXTENSIONS } from './lib/route-files';
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

  // 走査の根は src/app の route.* だけ。Next はこれ以外にも配信する入口を持つので、
  // それらが「無いこと」を固定する (存在すると、認証も認可も通らない経路がこの検査の外に生える。
  // 実測: src/pages/api/leak.ts も src/proxy.ts も全件緑のまま 200 を返した)
  it('App Router の route.* 以外に Next の入口が無い', () => {
    // 入口になるファイル名 (拡張子は pageExtensions の表から導く。列挙を手で書くと
    // proxy.tsx のような綴りが漏れる — 実測で未認証の 200 を返した)
    const entryBasenames = ['proxy', 'middleware'];
    // 存在してはいけない入口 (Pages Router・リポジトリ直下の app・middleware・proxy)。
    // リポジトリ直下に app があると Next は src/app を**丸ごと無視する**ので、走査の根ごとすり替わる
    const forbidden = [
      'pages',
      join('src', 'pages'),
      'app',
      ...entryBasenames.flatMap((name) =>
        PAGE_EXTENSIONS.flatMap((extension) => [
          `${name}.${extension}`,
          join('src', `${name}.${extension}`),
        ]),
      ),
    ];
    for (const entry of forbidden) {
      // 無いこと (足すなら、この検査と認可の網羅をどう広げるかを先に決める)
      expect(existsSync(join(process.cwd(), entry)), `${entry} は Next の入口になる`).toBe(false);
    }
  });

  // 走査する拡張子は Next.js の既定 pageExtensions に合わせた固定の表。設定で増やされると
  // その分が死角になるので、設定していないこと自体を固定する (増やすなら表も同時に直す)
  it('next.config.ts は pageExtensions を変えていない', () => {
    // 設定ファイルの中身
    const config = readFileSync(join(process.cwd(), 'next.config.ts'), 'utf8');
    // 拡張子の集合をいじっていないこと
    expect(config.includes('pageExtensions'), 'pageExtensions を変えるなら走査の表も直す').toBe(
      false,
    );
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

// src 配下の TypeScript ファイルを集める (秘密の読み取り箇所を数えるのに使う)
function findSourceFiles(dir: string): string[] {
  // 直下の要素
  return readdirSync(dir).flatMap((entry) => {
    // 絶対パス
    const full = join(dir, entry);
    // ディレクトリなら潜る (生成物は対象外)
    if (statSync(full).isDirectory()) return entry === 'generated' ? [] : findSourceFiles(full);
    // .ts / .tsx だけを拾う
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

// 行コメントとブロックコメントを落とす (説明文に書いた名前を「実装が触っている」と数えないため)
function stripComments(source: string): string {
  // ブロックコメント → 行コメントの順に落とす
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

// 関数本体に現れる return 文を、空白を詰めた形で並べる (抜け道が増えたかを見る)
function returnsIn(body: string | undefined): string[] {
  // 本体が読めなければ空 (呼び出し側が toBeDefined で落とす)
  if (body === undefined) return [];
  // return から ; までを 1 文として拾い、改行と連続する空白を 1 つに詰める
  return [...body.matchAll(/return[^;]*;/g)].map((match) => match[0].replace(/\s+/g, ' ').trim());
}

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
    // 抜ける道が定数時間比較の 1 つだけであること (長さで早期に返す形を足すと落ちる。
    // 呼び出し側をいくら厳しく見ても、比較の実装側にこの穴が空いていれば同じことになる)
    expect(returnsIn(body), '比較から抜ける道が増えている').toEqual([
      'return timingSafeEqual(left, right);',
    ]);
  });

  // 秘密を読む場所が 1 か所だけであること (別の場所で読めば、そこで安い比較を書けてしまう)
  it('PLATFORM_ADMIN_TOKEN に触れるのは照合の中だけ', () => {
    // 秘密の名前 (末尾に _ が続く別の定数 PLATFORM_ADMIN_TOKEN_MIN_LENGTH は対象外)。
    // process.env.X だけを探す形にすると、process.env['X'] や分割代入が素通りする (実測)
    const identifier = /\bPLATFORM_ADMIN_TOKEN\b(?!_)/g;
    // 認証のファイル以外では 1 度も現れないこと (別の場所で読めば、そこで安い比較を書ける)
    for (const file of findSourceFiles(join(process.cwd(), 'src'))) {
      // 認証のファイルは下で中身を見る
      if (file.endsWith(join('lib', 'api', 'auth.ts'))) continue;
      // コメントを落としてから探す (説明で名前を出すのは構わない)
      expect(stripComments(readFileSync(file, 'utf8')).match(identifier), file).toBeNull();
    }
    // 認証のファイルの中でも、現れるのは照合の関数の中だけであること
    const code = stripComments(auth);
    const bodyCode = stripComments(
      /function matchesPlatformAdminToken\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(auth)?.[1] ?? '',
    );
    // 関数の外に出ていないこと (件数が一致する = 全部が中にある)
    expect((code.match(identifier) ?? []).length).toBe((bodyCode.match(identifier) ?? []).length);
    // 中に 1 つ以上あること (走査が壊れて 0 件になったら落とす)
    expect((bodyCode.match(identifier) ?? []).length).toBeGreaterThan(0);
  });

  // 実装が定数時間でも、呼び出し側が === に戻れば同じこと (実測で全件緑のまま通った)
  it('プラットフォーム管理者トークンの照合は secretsEqual を通す', () => {
    // 照合関数の本体を切り出す
    const body = /function matchesPlatformAdminToken\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(auth)?.[1];
    // 本体が読めること
    expect(body, 'matchesPlatformAdminToken の定義が読めない').toBeDefined();
    // 定数時間比較のヘルパーを通していること
    expect(body && /secretsEqual\(/.test(body)).toBe(true);
    // 抜ける道 (return 文) が想定どおりの 3 つだけであること。禁止する綴りを並べる形では
    // 列挙の外側 (!= ・ charCodeAt のループ ・ 比較を別関数へ切り出す) がすべて素通りする (実測)。
    // 「増えた抜け道は必ず落ちる」側で見れば、安い比較を足す形は書き方によらず捕まる
    expect(returnsIn(body), '照合から抜ける道が増えている').toEqual([
      'return false;',
      'return false;',
      'return secretsEqual(token, configured);',
    ]);
  });
});
