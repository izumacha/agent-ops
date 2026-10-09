// 本番の実行経路そのものを見張る検査。
//   (1) Route Handler が必ず route() を通ること — 通らない export は認証も認可もキャッシュ制御も無いまま公開される
//   (2) 公開される HTTP メソッドが契約 (openapi.yaml) に載っていること
//   (3) トークンの乱数が暗号学的乱数であること・秘密の比較が定数時間であること
// いずれも「本番コードを壊しても全テストが緑」だった穴を塞ぐ。
// (1) は**実際にモジュールを読み込んで印を見る** — ソースの綴りを見る形だと、`export { PUT }` のような
// 別の書き方・OPTIONS のような別のメソッド・v1 の外のディレクトリがすべて死角になる (実測で素通りした)
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import {
  ALLOWED_ROUTE_FILE_NAME,
  findRouteFiles,
  HTTP_METHOD_EXPORTS,
  PAGE_EXTENSIONS,
} from './lib/route-files';
import { declaresDirective, forEachNode, parseSourceFiles } from './lib/source-files';
import ts from 'typescript';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { withResponseCount, RESPONSE_COUNT_BRAND } from '@/lib/api/response-count';
import { renderMetrics, resetMetricsForTesting } from '@/lib/metrics';
import {
  ROUTE_HANDLER_BRAND,
  ROUTE_RATE_LIMIT_BRAND,
  ROUTE_REQUIRED_ACTION_BRAND,
  ROUTE_REQUIRED_PLAN_FEATURE_BRAND,
  ROUTE_REQUIRED_ROLE_BRAND,
} from '@/lib/api/handler';
import { RATE_LIMIT_TIER } from '@/lib/api/rate-limit';
import { reachesModule, SRC_DIR, sourceImportGraph } from './lib/source-files';
import { PLAN_FEATURES } from '@/domain/plan';
import { NO_STORE_CACHE_CONTROL } from '@/lib/constants';
import {
  UNCOUNTED_RESPONSE_SOURCES,
  type UncountedResponseSource,
} from '@/lib/uncounted-response-sources';
import { ApiError } from '@/lib/api/errors';
import { HTTP_STATUS } from '@/lib/api/http-status';

// App Router の入口 (この下にある route.ts はすべて配信される)
const APP_DIR = join(process.cwd(), 'src', 'app');
// 契約が受け持つ API の入口 (OpenAPI の servers.url に対応)
const API_DIR = join(APP_DIR, 'api', 'v1');

// 認証を通さないことが正しい経路 (理由付きの唯一の除外。キーは src/app からの相対パス)
const UNAUTHENTICATED_ROUTES: Record<string, string> = {
  'api/v1/health/route.ts': 'DB 到達性だけを返す公開エンドポイント (compose の healthcheck が使う)',
};

// **署名で認証する受信 Webhook**（Step6）。Bearer 認証を使わないので `route()` を通らないが、
// REST の契約（openapi.yaml）には載る経路。**除外ではなく「別の認証」として扱う** —
// `route()` を通らないことを許す代わりに、**署名検証のモジュール（`@/lib/billing/signature`）へ
// 到達すること**をここで要求する（= 誰でも叩ける経路に認証がある。到達しなければ誰でも
// プランを書き換えられる）。
// **キャッシュ制御と応答の数え上げはここでは要求しない** — 包むラッパー
// （`withResponseCount`）が全応答へ行うので、「全 export がその印を持つ」検査と
// 「実際に応答を作ってヘッダを見る」検査の 2 本が全ルートまとめて固定する。
// **`RouteOptions` に `auth: 'none'` を足す形は採らなかった** — 既定を 1 つ緩めると、
// どのルートも宣言 1 行で未認証にできる口になる（理由は ADR-0012）。
// **ここに増える差分は理由の妥当性をレビューで必ず確認する**
const SIGNED_WEBHOOK_ROUTES: Record<string, string> = {
  'api/v1/billing/webhook/route.ts':
    '課金事業者 (Stripe) が呼ぶ受信 Webhook。呼び出し元は利用者ではないので Bearer 認証を' +
    '使えず、Stripe-Signature ヘッダの HMAC-SHA256 署名で認証する',
};

// **監視専用トークンで認証する経路**。`route()` の認証は Bearer トークンから `Principal`
// （テナント内のユーザー／プラットフォーム管理者／エージェント）を決める仕組みで、監視の
// 収集エージェントはそのどれでもない（テナントを持たず役割も持たない）。`Principal` の種類を
// 1 つ増やすと RBAC の許可表・プランのゲート・テナント境界の検査がすべてその種類を扱わねばならず、
// 「どこでも通る主体」を足すことになるので採らなかった。**除外ではなく「別の認証」として扱う** —
// `route()` を通らないことを許す代わりに、**監視用トークンの入口（`@/lib/api/metrics-auth`）へ
// 到達すること**をここで要求する（= 到達しなければ運用の数字が誰でも読める）。
// **キャッシュ制御と応答の数え上げはここでは要求しない**（上の署名 Webhook と同じ理由で、
// 全ルート共通の 2 本が固定する）。
// **ここに増える差分は理由の妥当性をレビューで必ず確認する**
const METRICS_TOKEN_ROUTES: Record<string, string> = {
  'api/v1/metrics/route.ts':
    'Prometheus の収集エージェントが読む運用の数字。テナントを持たない読み取り専用の' +
    '資格情報 (環境変数 METRICS_TOKEN) で認証し、プラットフォーム管理者トークンでは読めない' +
    '(あちらはテナント作成とプラン変更も通るので、収集エージェントへ配らない)',
};

// **画面側の Route Handler** (Step5)。セッション Cookie で認証し、JSON ではないものを返す経路で、
// REST の契約 (openapi.yaml) には載らない。**除外ではなく「別の契約」として扱う** —
// api/v1 の下に置かないこと・route() を通らないことを許す代わりに、下の 2 つを必ず要求する:
//   (a) api/v1 の**外**にあること (契約の下に紛れ込ませない)
//   (b) `@/lib/session-server` へ到達すること (= セッションを自分で確かめている)
// **キャッシュ制御と応答の数え上げはここでは要求しない**（上の 2 つの表と同じ理由で、
// 全ルート共通の 2 本が固定する）
// **ここに増える差分は理由の妥当性をレビューで必ず確認する**。表に無い route.ts は
// 従来どおり「api/v1 の下で route() を通る」ことを要求される
const SESSION_PAGE_ROUTES: Record<string, string> = {
  '(dashboard)/reports/daily/route.ts':
    '日次レポートの CSV ダウンロード。ブラウザのセッションで認証し text/csv を返すので、' +
    'Bearer 認証・JSON 応答を前提にした route() と OpenAPI の契約には載せられない',
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

// src 全体の import グラフ。**モジュール評価時に 1 度だけ作る** —
// `parseSourceFiles()` が src 配下の全 .ts/.tsx を TypeScript パーサで読むので、テストごとに
// 作り直すとその走査が丸ごと二重になる（`reachesModule` が graph を引数で受ける形も
// 「1 度作って使い回す」ことを前提にしている）
// 解析済みの src 全体。**1 度だけ作る** — テストの中で呼ぶと、1 回の `npm test` で
// このファイルだけが src を何度も解析する（この PR は 1 か所だったものを 3 か所に
// 増やしていた）。`tests/layering.test.ts` も同じ形で持っている
const parsedSources = parseSourceFiles();

// src 全体の import グラフ。**解析済みを渡す** — 渡さないと `sourceImportGraph` が
// 中でもう一度 src 全体をパースし、このファイルだけで 2 周ぶん走る（実測の指摘）
const importGraph = sourceImportGraph(parsedSources);

describe('Route Handler の結線', () => {
  // 走査が壊れて 0 件になったら落とす (fail-closed)
  it('Route Handler を 1 つ以上見つけている', () => {
    // 見つけた数
    expect(routeFiles.length).toBeGreaterThan(0);
  });

  // 契約の外に生やした経路は、認可の網羅ガード (tests/api/rbac-endpoints.test.ts) の対象にもならない
  it('Route Handler は契約が受け持つ api/v1 の下にしか置かれていない (画面側ルートを除く)', () => {
    for (const { full, relativeToApp } of routeFiles) {
      // api/v1 の外にあるか
      const outside = toPosix(relative(API_DIR, full)).startsWith('..');
      // 画面側ルートとして理由を書いてあるものは**外にあることを要求する**
      if (Object.hasOwn(SESSION_PAGE_ROUTES, relativeToApp)) {
        expect(outside, `${relativeToApp} は画面側ルートなので api/v1 の下に置かない`).toBe(true);
        continue;
      }
      // それ以外は api/v1 の下にあること
      expect(outside, `${relativeToApp} が api/v1 の外にある`).toBe(false);
    }
  });

  it('画面側ルートの表に載っているファイルは実在し、理由が書かれている', () => {
    // 走査で見つかった route.ts の一覧 (src/app からの相対パス)
    const found = new Set(routeFiles.map(({ relativeToApp }) => relativeToApp));
    for (const [key, reason] of Object.entries(SESSION_PAGE_ROUTES)) {
      // 消えたファイルの登録が残っていないこと (残ると「何を許したのか」が読めなくなる)
      expect(found.has(key), `${key} は実在しない (表の登録が古い)`).toBe(true);
      // 理由が空・空白でないこと (値を誰も読まないと「とりあえず黙らせる」口になる)
      expect(reason.trim().length, `${key} の理由が空`).toBeGreaterThan(0);
    }
  });

  it('画面側ルートはセッションを自分で確かめている', () => {
    // 走査が壊れていたら fail-closed で落とす
    const sessionModule = join(SRC_DIR, 'lib', 'session-server.ts');
    expect(importGraph.has(sessionModule), 'セッションの入口を走査できていない').toBe(true);
    // 表に載っている画面側ルートを 1 本ずつ見る
    const entries = Object.keys(SESSION_PAGE_ROUTES);
    // 1 本も無ければ導出が壊れている (黙って「対象ゼロ＝緑」にしない)
    expect(entries.length, '画面側ルートが 1 本も無い').toBeGreaterThan(0);
    for (const key of entries) {
      // 走査で見つけた実体を引く
      const file = routeFiles.find(({ relativeToApp }) => relativeToApp === key);
      expect(file, `${key} を走査できていない`).toBeDefined();
      // (b) セッションの入口へ到達していること (= 自分で認証を確かめている)
      expect(
        reachesModule(importGraph, file!.full, sessionModule),
        `${key} がセッションの確認を通っていない`,
      ).toBe(true);
    }
  });

  it('署名 Webhook の表に載っているファイルは実在し、理由が書かれている', () => {
    // 走査で見つかった route.ts の一覧 (src/app からの相対パス)
    const found = new Set(routeFiles.map(({ relativeToApp }) => relativeToApp));
    // 表が空なら走査が空振りしている (fail-closed)
    expect(Object.keys(SIGNED_WEBHOOK_ROUTES).length).toBeGreaterThan(0);
    for (const [key, reason] of Object.entries(SIGNED_WEBHOOK_ROUTES)) {
      // 消えたファイルの登録が残っていないこと
      expect(found.has(key), `${key} は実在しない (表の登録が古い)`).toBe(true);
      // 理由が空・空白でないこと
      expect(reason.trim().length, `${key} の理由が空`).toBeGreaterThan(0);
    }
  });

  it('署名 Webhook は署名検証を通っている', () => {
    // 署名検証のモジュール (走査できていなければ fail-closed で落とす)
    const signatureModule = join(SRC_DIR, 'lib', 'billing', 'signature.ts');
    expect(importGraph.has(signatureModule), '署名検証の入口を走査できていない').toBe(true);
    // 表に載っている Webhook を 1 本ずつ見る
    const entries = Object.keys(SIGNED_WEBHOOK_ROUTES);
    expect(entries.length, '署名 Webhook が 1 本も無い').toBeGreaterThan(0);
    for (const key of entries) {
      // 走査で見つけた実体を引く
      const file = routeFiles.find(({ relativeToApp }) => relativeToApp === key);
      expect(file, `${key} を走査できていない`).toBeDefined();
      // (a) 署名検証へ到達していること (= 誰でも叩ける経路に認証がある)
      expect(
        reachesModule(importGraph, file!.full, signatureModule),
        `${key} が署名の検証を通っていない`,
      ).toBe(true);
    }
  });

  it('監視専用トークンの表に載っているファイルは実在し、理由が書かれている', () => {
    // 走査で見つかった route.ts の一覧 (src/app からの相対パス)
    const found = new Set(routeFiles.map(({ relativeToApp }) => relativeToApp));
    // 表が空なら走査が空振りしている (fail-closed)
    expect(Object.keys(METRICS_TOKEN_ROUTES).length).toBeGreaterThan(0);
    for (const [key, reason] of Object.entries(METRICS_TOKEN_ROUTES)) {
      // 消えたファイルの登録が残っていないこと
      expect(found.has(key), `${key} は実在しない (表の登録が古い)`).toBe(true);
      // 理由が空・空白でないこと
      expect(reason.trim().length, `${key} の理由が空`).toBeGreaterThan(0);
    }
  });

  it('監視専用トークンの経路は専用の入口で認証している', () => {
    // 監視用トークンの入口 (走査できていなければ fail-closed で落とす)
    const authModule = join(SRC_DIR, 'lib', 'api', 'metrics-auth.ts');
    expect(importGraph.has(authModule), '監視用トークンの入口を走査できていない').toBe(true);
    // 表に載っている経路を 1 本ずつ見る
    const entries = Object.keys(METRICS_TOKEN_ROUTES);
    expect(entries.length, '監視専用トークンの経路が 1 本も無い').toBeGreaterThan(0);
    for (const key of entries) {
      // 走査で見つけた実体を引く
      const file = routeFiles.find(({ relativeToApp }) => relativeToApp === key);
      expect(file, `${key} を走査できていない`).toBeDefined();
      // (a) 監視用トークンの入口へ到達していること (= 誰でも読める状態になっていない)
      expect(
        reachesModule(importGraph, file!.full, authModule),
        `${key} が監視用トークンの確認を通っていない`,
      ).toBe(true);
    }
  });

  // **応答を数えるのは全ルート共通の要求**（ADR-0014）。
  //
  // `route()` の中だけで数えていた頃は、`route()` を通らない 4 本（health・受信 Webhook・
  // 画面側の CSV・/metrics 自身）が**メトリクスにもログにも 1 件も現れなかった**。
  // とくに受信 Webhook は未認証で誰でも叩ける経路なので、署名鍵の設定ミスで全件 401 に
  // なっても、401 の山がどの出口にも出ない（運用者は気付けない）。
  //
  // **要求するのは「数える関数を呼ぶこと」ではなく「共通のラッパーを通ること」。**
  // 数える 3 行を各ルートへ書き写していた版では、包む側が毎回 2 つの判断を自分でしており、
  // どちらも実際に間違えた: (a) 本体を `try` で包むか（包み忘れた画面側の CSV は例外のとき
  // 何も数えず、5xx が系列に現れなかった）、(b) メソッドを何で渡すか（文字列を書いた 3 本は
  // `HEAD` を `GET` として数え、`route()` 側は `other` として数えた）。
  //
  // **判定は印（`RESPONSE_COUNT_BRAND`）を実体から読む。** 綴りで照合していた版は
  // **コメントに関数名が出ているだけで条件を満たした**（実測: 画面側の CSV を自前で数える形へ
  // 戻しても、上に残った説明の綴りが検査を満たして全件緑で通った）。
  //
  // **一覧は持たない** — `src/app` の全 `route.ts` の、Next.js が呼ぶ export すべてに要求する
  // （`route()` が包んだ関数も内側でこのラッパーを通るので同じ印を持つ）。
  it('Route Handler の export はすべて応答を数えるラッパーを通っている', async () => {
    // 実際に印を確かめた数（0 件なら走査が壊れている）
    let checked = 0;
    for (const { full, relativeToApp } of routeFiles) {
      // モジュールを実際に読み込む（綴りではなく値を見る）
      const routeModule: Record<string, unknown> = await import(pathToFileURL(full).href);
      for (const method of HTTP_METHOD_EXPORTS) {
        // その名前を export していなければ何もしない
        const exported = routeModule[method];
        if (exported === undefined) continue;
        checked += 1;
        // 数えるラッパーの印を持つこと
        expect(
          typeof exported === 'function' &&
            (exported as unknown as Record<symbol, unknown>)[RESPONSE_COUNT_BRAND] === true,
          `${relativeToApp} の ${method} が応答を数えるラッパーを通っていない`,
        ).toBe(true);
      }
    }
    // 1 つも見ていなければ走査が壊れている (fail-closed)
    expect(checked, 'Route Handler の export を 1 つも見つけられない').toBeGreaterThan(0);
  });

  // **包むラッパーは「本体が返した応答」にもキャッシュ制御を付ける。**
  //
  // 例外の経路にだけ付けていた版では、本体が**返した**早期の 401 / 404 に付かなかった
  // （画面側の CSV がそれで、認証付きの経路の 401 / 404 が共有キャッシュへ載りうる状態だった）。
  // ルートごとに `no-store` の綴りを探す検査では**成功の経路の 1 行で条件が満たされる**ので、
  // 返した 401 / 404 は覆えていなかった。ここで**実際に応答を作って**固定する
  it.each([
    { label: '返した', build: (): Response => new Response('x', { status: 401 }) },
    {
      label: '投げた',
      build: (): Response => {
        throw new ApiError(HTTP_STATUS.UNAUTHORIZED, 'だめ');
      },
    },
  ])('応答を数えるラッパーは $label 応答にもキャッシュ制御を付ける', async ({ build }) => {
    // 本体を包む
    const handler = withResponseCount(() => Promise.resolve(build()));
    // 呼ぶ（メソッドは要求から読まれる）
    const response = await handler(new Request('http://test.local/x'));
    // 保存させない
    expect(response.headers.get('cache-control')).toBe(NO_STORE_CACHE_CONTROL);
    // 資格情報ごとに分ける。**ちょうど 1 回だけ並ぶこと** — `append` は冪等でないので、
    // 包む側と包まれる側が両方これを呼んでいた頃は全 API 応答が
    // `Vary: Authorization, Authorization` を返していた（実測）
    expect(response.headers.get('vary')).toBe('Authorization, Cookie');
  });

  // **二重に包んでも 1 件しか数えない（冪等）。**
  //
  // `withResponseCount(route(handler))` は自然な書き間違いで（この PR の 4 本は素の
  // `withResponseCount(...)` を使い、上の印の検査は「全 export に印がある」ことしか求めない）、
  // 印は外側に付くので**検出網は緑のまま**。内側と外側が同じ応答を 2 度数えるので
  // `agentops_http_responses_total` が**実際の 2 倍**を報告し、率の警報が 2 倍ずれる
  it('応答を数えるラッパーは二重に包んでも 1 件しか数えない', async () => {
    // 計数を空から始める
    resetMetricsForTesting();
    // 二重に包む（内側は既に印が付いている）
    const inner = withResponseCount(() => Promise.resolve(new Response('x')));
    const outer = withResponseCount(inner);
    // 包み直されず同じ関数が返ること（冪等）
    expect(outer).toBe(inner);
    // 1 回呼ぶ
    await outer(new Request('http://test.local/x'));
    // 出力の中で該当する系列の値を読む（`agentops_http_responses_total{...} <値>` の行）
    const line = renderMetrics(new Date())
      .split('\n')
      .find((row) => row.startsWith('agentops_http_responses_total{'));
    // ちょうど 1 件（2 なら二重に数えている）
    expect(line, '応答の系列が 1 本も出ていない').toBeDefined();
    expect(line?.trim().split(' ').at(-1)).toBe('1');
    // 後始末（他のテストへ計数を持ち越さない）
    resetMetricsForTesting();
  });

  // **Next.js の制御フローの例外は応答へ写さない。**
  //
  // `redirect()` / `notFound()` / `forbidden()` / `unauthorized()` は「応答を決める」ための
  // 例外を投げて止まる仕組みなので、包む側が捕まえて 500 の JSON に写すと**遷移も 404 も
  // 起きず、`api.unexpected_error` の警報まで鳴る**。画面の枝で使う `requireSession()` が
  // まさにこの 2 つを投げるので、画面側の CSV を `currentSession()` から寄せる 1 行の整理で
  // 踏みうる
  it.each([
    { label: 'redirect()', digest: 'NEXT_REDIRECT;replace;/login;303;' },
    { label: 'notFound()', digest: 'NEXT_HTTP_ERROR_FALLBACK;404' },
  ])('応答を数えるラッパーは $label の例外を応答へ写さず投げ直す', async ({ digest }) => {
    // Next.js が投げるのと同じ形の例外（種類は digest で表される）
    const control = Object.assign(new Error('control flow'), { digest });
    // 本体がそれを投げる形で包む
    const handler = withResponseCount(() => Promise.reject(control));
    // 包んだ関数を呼ぶと、同じ例外がそのまま出てくること（500 の応答にならない）
    await expect(handler(new Request('http://test.local/x'))).rejects.toBe(control);
  });

  // **制御フローの判定そのものが例外で壊れないこと。**
  //
  // 判定を上流の `unstable_rethrow(error)` に丸ごと任せていた版は、あれが最後に
  // `error.cause` を辿るため **`cause` がゲッターなら判定が投げ**、自分を指していれば
  // `RangeError` になった（どちらも実測）。そうなると 500 の契約も `api.unexpected_error` の
  // ログも `countHttpResponse` もまとめて飛び、**ラッパーの外へ素の例外が漏れる**。
  // `src/lib/describe-error.ts` が同じ罠を記録している（`'cause' in error` はゲッターを
  // 起こさないが、続く読み出しは起こす）
  it.each([
    {
      label: 'cause のゲッターが投げる',
      build: (): unknown => {
        const error = new Error('inner');
        Object.defineProperty(error, 'cause', {
          get() {
            throw new Error('cause getter exploded');
          },
        });
        return error;
      },
    },
    {
      label: 'cause が自分を指す',
      build: (): unknown => {
        const error = new Error('cyclic');
        Object.defineProperty(error, 'cause', { value: error });
        return error;
      },
    },
    {
      label: 'digest のゲッターが投げる',
      build: (): unknown => {
        const error = new Error('digest');
        Object.defineProperty(error, 'digest', {
          get() {
            throw new Error('digest getter exploded');
          },
        });
        return error;
      },
    },
  ])('$label 例外でも、ラッパーは 500 の応答を返す', async ({ build }) => {
    // 本体がその例外を投げる形で包む
    const handler = withResponseCount(() => Promise.reject(build()));
    // 応答が返ること（例外が外へ漏れない）
    const response = await handler(new Request('http://test.local/x'));
    // 内部エラーとして写っていること
    expect(response.status).toBe(HTTP_STATUS.INTERNAL_SERVER_ERROR);
    // キャッシュ制御も付いていること（この経路も全応答と同じ扱い）
    expect(response.headers.get('cache-control')).toBe(NO_STORE_CACHE_CONTROL);
  });

  // **ヘッダの押印そのものが投げても、例外はラッパーの外へ漏らさない。**
  //
  // `withPrivateCacheHeaders` は `new Response(response.body, …)` で作り直すので、本体が
  // **本文を既に読んだ／奪われた** `Response` を返すと Fetch の仕様どおり `TypeError` になる
  // （実測: `Response body object should not be disturbed or locked`）。押印を包む側（`try` の
  // 外）で行っていた版では、そのとき 500 の契約も `api.unexpected_error` のログも
  // `countHttpResponse` もまとめて飛んだ
  it.each([
    {
      label: '本文を読んだ',
      build: async (): Promise<Response> => {
        const response = new Response('x');
        await response.text();
        return response;
      },
    },
    {
      label: '本文を奪われた',
      build: (): Promise<Response> => {
        const response = new Response('y');
        response.body?.getReader();
        return Promise.resolve(response);
      },
    },
  ])('$label 応答を返す本体でも、ラッパーは 500 の応答を返す', async ({ build }) => {
    // 本体がその応答を返す形で包む
    const handler = withResponseCount(build);
    // 応答が返ること（例外が外へ漏れない）
    const response = await handler(new Request('http://test.local/x'));
    // 内部エラーとして写っていること
    expect(response.status).toBe(HTTP_STATUS.INTERNAL_SERVER_ERROR);
    // キャッシュ制御も付いていること
    expect(response.headers.get('cache-control')).toBe(NO_STORE_CACHE_CONTROL);
  });

  // **`src/app` 配下で応答を返すものの種類を数え上げる。**
  //
  // 応答を数えるのは `route.ts` の export だけで、そこは上の印の検査が全数を押さえている。
  // 問題は**それ以外に応答を返すもの**で、以前は文書も `metrics.ts` の docstring も
  // 「数えられない経路は入口の 404 が 1 つだけ」と書いていた。実際には画面の描画
  // （`page.tsx` 等）と Server Action が**1 件も数えられていない**まま言及されておらず、
  // 運用者が「他の HTTP 通信はすべてこの系列に乗る」と読める状態だった（ダッシュボードの
  // ログイン総当たりを警報の条件に書いても一度も発火しない）。
  //
  // **分類は導出で、除外表を持たない。** `src/app` 配下のファイルは必ず次のどれかになる:
  //   - `route.ts`                → 数える（印の検査が押さえる）
  //   - `.tsx`                    → 画面の描画（`pageRender`）
  //   - `'use server'` のモジュール → Server Action（`serverAction`）
  //   - それ以外の `.ts`          → 上のどれかから取り込まれる部品（自分では応答を返さない）
  // どれにも当たらないものがあれば、**新しい種類の入口が生えた**か到達不能な死んだファイル。
  // どちらも「数えない種類が増えたのに文書が古いまま」になる前に手を止める必要がある
  it('src/app 配下で応答を返すものは、数える経路か宣言済みの「数えない種類」のどちらか', () => {
    // src/app 配下の .ts / .tsx を構文木つきで集める
    const appFiles = parsedSources.filter((parsed) => parsed.path.startsWith(`${APP_DIR}/`));
    // 1 つも拾えなければ走査が壊れている（fail-closed）
    expect(appFiles.length, 'src/app 配下のファイルを拾えている').toBeGreaterThan(0);
    // 数える入口（route.ts）と、数えない種類に当たるもの
    const counted = appFiles.filter((parsed) => basename(parsed.path) === ALLOWED_ROUTE_FILE_NAME);
    const rendered = appFiles.filter((parsed) => parsed.path.endsWith('.tsx'));
    const actions = appFiles.filter((parsed) => declaresDirective(parsed, 'use server'));
    // 分類できた種類ごとに、`metrics.ts` の表に宣言があること（文書の目印もそこから導く）。
    // **`entryProxy` と `nextControlFlow` はここに並べない** — 前者は `src/app` の外、
    // 後者は「ファイルの種類」ではなく投げる箇所なので、ファイルの分類では表せない
    // （それぞれ別の検査と `docs-gate` の目印が受け持つ）
    const declared: { source: UncountedResponseSource; files: string[] }[] = [
      { source: 'pageRender', files: rendered.map((parsed) => parsed.path) },
      { source: 'serverAction', files: actions.map((parsed) => parsed.path) },
    ];
    for (const { source, files } of declared) {
      // その種類が実在することと、表に宣言があること
      expect(files.length, `${source} に当たるファイルがある`).toBeGreaterThan(0);
      expect(
        UNCOUNTED_RESPONSE_SOURCES[source],
        `${source} が UNCOUNTED_RESPONSE_SOURCES に宣言されている`,
      ).toBeDefined();
    }
    // 分類済みの入口（ここから取り込まれる .ts は部品）
    const entries = [...counted, ...rendered, ...actions].map((parsed) => parsed.path);
    // 残り（どの入口でもない .ts）が、少なくとも 1 つの入口から辿れること
    const orphans = appFiles
      .filter((parsed) => !entries.includes(parsed.path))
      .filter((parsed) => !entries.some((entry) => reachesModule(importGraph, entry, parsed.path)))
      .map((parsed) => relative(APP_DIR, parsed.path));
    // 辿れないものは「新しい種類の入口」か死んだファイル。どちらも手を止めて決める
    expect(orphans).toEqual([]);
  });

  // 入口（`src/proxy.ts`）は「数えない種類」として宣言されていること。
  //
  // **「数えようとしても見えない」は本番ビルドでの実測**（入口は Route Handler とは別の
  // モジュール実体で評価されるので、health の 200 は `/metrics` に現れるのに入口の 404 は
  // 2 件とも現れなかった）。ここで固定できるのはその実測そのものではなく、
  // **数える関数を持ち込んでいないこと** — 「呼べば見えるはず」と考えた人が足すと、
  // 見えない数え上げが黙って残る。
  //
  // **モジュールへの到達では見られない** — 入口は `@/lib/log` を取り込み、その先が
  // `@/lib/metrics` なので到達は必ず true になる（まさにそれが、入口から出した
  // `entry.undecodable_path` の行数も `/metrics` に現れない理由）。見るのは
  // **数える関数を名指しで取り込んでいるか**
  it('入口は応答を数える関数を取り込まず、数えない種類として宣言されている', () => {
    // 表に宣言があること
    expect(UNCOUNTED_RESPONSE_SOURCES.entryProxy).toBeDefined();
    // 入口の構文木（拾えなければ fail-closed）
    const entry = parsedSources.find((parsed) => parsed.path === join(SRC_DIR, 'proxy.ts'));
    expect(entry, '入口を走査できていない').toBeDefined();
    // 名前付き import の識別子を集める
    const imported: string[] = [];
    forEachNode(entry!.source, (node) => {
      // import 宣言のうち、名前付きの束だけを見る
      if (!ts.isImportDeclaration(node)) return;
      const bindings = node.importClause?.namedBindings;
      if (bindings === undefined || !ts.isNamedImports(bindings)) return;
      // その束の各要素の名前（`as` で別名を付けていれば元の名前）
      for (const element of bindings.elements) {
        imported.push((element.propertyName ?? element.name).text);
      }
    });
    // 1 つも拾えなければ走査が壊れている（入口は必ず何か取り込んでいる）
    expect(imported.length, '入口の import を拾えている').toBeGreaterThan(0);
    // 数える関数を取り込んでいないこと
    expect(imported, '入口が応答を数える関数を取り込んでいる（数えても見えない）').not.toContain(
      'countHttpResponse',
    );
  });

  // 意図して置いている Next の入口と、その理由 (**ここに増える差分は理由の妥当性をレビューで必ず確認する**)。
  // キーはリポジトリ相対のパス。表に無い綴り・場所はすべて「無いこと」を要求する
  const ALLOWED_NEXT_ENTRIES: Record<string, string> = {
    'src/proxy.ts':
      'パスの percent-decode に失敗する要求を 404 で落とす入口 (素通しすると Next.js が params を' +
      '組み立てる時点で例外になり、認証ヘッダ無しで全ルートが素の 500 を返す)。返すのは 404 か' +
      '「次へ渡す」だけで、データを返す経路にはしない。挙動は tests/proxy.test.ts が固定する',
  };

  // 走査の根は src/app の route.* だけ。Next はこれ以外にも配信する入口を持つので、
  // 理由を書いたもの以外は「無いこと」を固定する (存在すると、認証も認可も通らない経路がこの検査の
  // 外に生える。実測: src/pages/api/leak.ts も src/proxy.ts も全件緑のまま 200 を返した)
  it('App Router の route.* 以外に Next の入口が無い (理由を書いたものを除く)', () => {
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
      // 理由を書いた入口は許す (綴りも場所も表に書いたものだけ)
      if (toPosix(entry) in ALLOWED_NEXT_ENTRIES) continue;
      // それ以外は無いこと (足すなら、この検査と認可の網羅をどう広げるかを先に決める)
      expect(existsSync(join(process.cwd(), entry)), `${entry} は Next の入口になる`).toBe(false);
    }
  });

  // 許可表が古くなっていないこと。実在しない入口を並べたままにすると、「理由を書いた例外」が
  // 増えているように見えて実際には何も守っておらず、次に同じ綴りのファイルを置いた人が素通りする
  it('例外として許した Next の入口は実在する', () => {
    // 表が空なら走査が空振りしている (fail-closed)
    expect(Object.keys(ALLOWED_NEXT_ENTRIES).length).toBeGreaterThan(0);
    for (const entry of Object.keys(ALLOWED_NEXT_ENTRIES)) {
      // 表のキーがリポジトリに実在すること
      expect(existsSync(join(process.cwd(), entry)), `${entry} が存在しない`).toBe(true);
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
      // 画面側ルートは route() を通らない代わりに上の 3 つを要求されている (理由は表に書く)
      if (Object.hasOwn(SESSION_PAGE_ROUTES, relativeToApp)) continue;
      // 署名で認証する受信 Webhook も同じ扱い (理由は表に書く。要求は下の専用テスト)
      if (Object.hasOwn(SIGNED_WEBHOOK_ROUTES, relativeToApp)) continue;
      // 監視専用トークンで認証する経路も同じ扱い (理由は表に書く。要求は下の専用テスト)
      if (Object.hasOwn(METRICS_TOKEN_ROUTES, relativeToApp)) continue;
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

  // **上流 LLM を呼ぶルートはレート制限を掛ける。**
  //
  // `rateLimit` は既定が「掛けない」なので、付け忘れは 429 ではなく**制限なし**に倒れる
  // (handler.ts のコメントが認めている fail-open)。掛ける対象は「外部へ費用を発生させる経路」で、
  // それは **import の連鎖から導ける** — 上流を実際に呼ぶのは `src/lib/proxy/upstream.ts` の
  // 1 か所だけ (judge も同じ結線を共有する。ADR-0009) なので、そこへ到達するルートが対象。
  //
  // **手書きの一覧にしない** — 一覧だと、上流を呼ぶルートを新しく足した人が一覧への追記を
  // 忘れたぶんだけ検出網が静かに狭まる (この repo が繰り返し避けている形)。実測でも、
  // POST /evaluations は 1 要求で最大 400 回の課金対象の呼び出しを出すのに制限が無く、
  // プロキシに置いた保護を「中継の代わりに評価を回す」だけで迂回できた。
  //
  // **判定は印 (ROUTE_RATE_LIMIT_BRAND) を実体から読む** — ソースの綴りを見る形は
  // 設定を変数へ出す・展開する・別名で渡すといった書き方がすべて死角になる。
  //
  // **残る境界**: 粒度はモジュール単位なので、見るのは非 GET の export に限る
  // (同じモジュールの GET は一覧の読み出しで上流を呼ばない)。上流を呼ぶ GET を足すと
  // この網からは外れるので、そのときはここを広げること。
  it('上流 LLM を呼ぶルートの非 GET はレート制限を掛けている', async () => {
    // src 全体の import グラフ (モジュール評価時に 1 度だけ作ったもの)
    const graph = importGraph;
    // 上流を呼ぶモジュール (到達を調べる相手)
    const upstream = join(SRC_DIR, 'lib', 'proxy', 'upstream.ts');
    // グラフに乗っていなければ走査が壊れている (fail-closed)
    expect(graph.has(upstream), '上流を呼ぶモジュールを走査できていない').toBe(true);
    // 上流へ到達するルート
    const costly = routeFiles.filter(({ full }) => reachesModule(graph, full, upstream));
    // 1 本も無ければ導出が壊れている (fail-closed。黙って「対象ゼロ＝緑」にしない)
    expect(costly.length, '上流へ到達するルートを 1 本も見つけられない').toBeGreaterThan(0);
    // 実際に印を確かめた数
    let checked = 0;
    for (const { full, relativeToApp } of costly) {
      // モジュールを読み込む (綴りではなく値を見る)
      const routeModule: Record<string, unknown> = await import(pathToFileURL(full).href);
      for (const method of HTTP_METHOD_EXPORTS) {
        // GET は読み出しなので対象外 (上の「残る境界」)
        if (method === 'GET') continue;
        // その名前を export していなければ何もしない
        const exported = routeModule[method];
        if (exported === undefined) continue;
        // レート制限の印を持つこと
        checked += 1;
        expect(
          (exported as unknown as Record<symbol, unknown>)[ROUTE_RATE_LIMIT_BRAND] !== null,
          `${relativeToApp} の ${method} は上流を呼ぶのにレート制限が無い`,
        ).toBe(true);
      }
    }
    // 1 つも見ていなければ走査が壊れている
    expect(checked, 'レート制限を確かめた export が 0 件').toBeGreaterThan(0);
  });

  // **1 要求で何十回も上流へ出るルートは専用の小さい枠 (fanOut) で数える。**
  //
  // 回数だけを数える枠は、1 要求の重さが 2 桁違う経路には保護にならない — 中継と同じ
  // 毎分 600 要求を許すと、評価の経路では上流呼び出し 24 万回ぶんを許すことになる
  // (1 要求が最大 EVALUATION_SET_MAX_CASES 件 × 2 回)。
  //
  // **対象は import の連鎖から導く** — ケースを回して上流を呼ぶのは
  // `src/lib/evaluation/runner.ts` の 1 か所なので、そこへ到達するルートが対象。
  // 手書きの一覧だと、同じ形のルート (「まとめて回す」系) を足した人が追記を忘れたぶんだけ
  // 網が静かに狭まる。**判定は枠の種類まで印から読む** — 真偽値だと fanOut を standard へ
  // 落とす変更が見えない。
  //
  // **残る境界**: この網が導けるのは「ケースを回す経路」だけ。応答を返す前に外部の往復を
  // 待つ経路 (`POST /guardrails/run`、枠は `outbound`) は連鎖から区別できない (通知のモジュールへ
  // 到達するのは中継も同じで、あちらは待たずに投げる) ので、そちらは下の個別の検査が固定する。
  it('ケースをまとめて回すルートは fanOut の枠で数えている', async () => {
    // src 全体の import グラフ (上と同じインスタンス)
    const graph = importGraph;
    // ケースを回して上流を呼ぶモジュール
    const runner = join(SRC_DIR, 'lib', 'evaluation', 'runner.ts');
    // グラフに乗っていなければ走査が壊れている (fail-closed)
    expect(graph.has(runner), '評価の実行モジュールを走査できていない').toBe(true);
    // そこへ到達するルート
    const fanOut = routeFiles.filter(({ full }) => reachesModule(graph, full, runner));
    // 1 本も無ければ導出が壊れている (fail-closed)
    expect(fanOut.length, 'ケースを回すルートを 1 本も見つけられない').toBeGreaterThan(0);
    // 実際に印を確かめた数
    let checked = 0;
    for (const { full, relativeToApp } of fanOut) {
      // モジュールを読み込む (綴りではなく値を見る)
      const routeModule: Record<string, unknown> = await import(pathToFileURL(full).href);
      for (const method of HTTP_METHOD_EXPORTS) {
        // GET は読み出しなので対象外 (一覧はケースを回さない)
        if (method === 'GET') continue;
        // その名前を export していなければ何もしない
        const exported = routeModule[method];
        if (exported === undefined) continue;
        // fanOut の枠であること
        checked += 1;
        expect(
          (exported as unknown as Record<symbol, unknown>)[ROUTE_RATE_LIMIT_BRAND],
          `${relativeToApp} の ${method} は 1 要求で何十回も上流へ出るのに fanOut の枠ではない`,
        ).toBe(RATE_LIMIT_TIER.fanOut);
      }
    }
    // 1 つも見ていなければ走査が壊れている
    expect(checked, 'fanOut の枠を確かめた export が 0 件').toBeGreaterThan(0);
  });

  // **追加の枠を持つルートは、レート制限より前に認可する。**
  //
  // レート制限は認証の後・本体の前に掛かるので、`route()` の側で認可しないと**権限の無い
  // 利用者がテナント全体の小さい枠を使い切れる** — view しか持たない利用者が
  // `POST /evaluations` を 6 回投げると、どれも本体で 403 になるのに枠は消費され、同じテナントの
  // operator / admin が窓のあいだ 429 になる。枠はベンダーへの課金を抑えるためのものなので、
  // **上流へ 1 度も出ない要求で消費されるのは誤り**。
  //
  // **対象は印から導く** — 追加の枠を持つ種類（`EXTRA_FRAME_LIMIT` が上限を持つもの）を
  // 1 つでも指定しているルートが対象なので、新しく重い枠を足した人が宣言を忘れたら落ちる
  it('追加の枠を持つルートはレート制限より前に認可している', async () => {
    // 確かめた数（0 件なら印の読み取りか走査が壊れている）
    let checked = 0;
    for (const { full, relativeToApp } of routeFiles) {
      // モジュールを読み込む（綴りではなく値を見る）
      const routeModule: Record<string, unknown> = await import(pathToFileURL(full).href);
      for (const method of HTTP_METHOD_EXPORTS) {
        // その名前を export していなければ何もしない
        const exported = routeModule[method];
        if (exported === undefined) continue;
        // 枠の種類を印から読む
        const brands = exported as unknown as Record<symbol, unknown>;
        const tier = brands[ROUTE_RATE_LIMIT_BRAND];
        // 追加の枠を持たない種類（未指定・standard）は対象外
        if (tier === null || tier === undefined || tier === RATE_LIMIT_TIER.standard) continue;
        // **操作かロールのどちらかが宣言されていること。** admin 限定のルートは
        // `requiredAction` では表せない（RBAC の許可表に「admin だけが持つ操作」が無く、
        // `view` は 3 役割すべてが持つので viewer が枠を使い切れる）
        checked += 1;
        expect(
          brands[ROUTE_REQUIRED_ACTION_BRAND] ?? brands[ROUTE_REQUIRED_ROLE_BRAND],
          `${relativeToApp} の ${method} は追加の枠を持つのに requiredAction / requiredRole を宣言していない`,
        ).not.toBeNull();
      }
    }
    // 1 つも見ていなければ走査が壊れている（fail-closed。「対象ゼロ＝緑」にしない）
    expect(checked, '追加の枠を持つ export が 0 件').toBeGreaterThan(0);
  });

  // **プランで可否が決まる機能は、宣言した機能ぶんのルートが実在すること。**
  //
  // 手がかりは `PLAN_FEATURES`（プランの表の正本）で、**機能を足して `route()` の宣言を
  // 忘れたら落ちる** — 宣言の無い機能は「表では有料プラン限定なのに、実際は誰でも使える」
  // 飾りになる（`tests/audit-coverage.test.ts` が操作名に発行箇所の実在を求めるのと同じ形）。
  //
  // **逆向き（本来ゲートすべきルートが宣言を持たないこと）は導けない** — 「重い読み取りか」
  // 「有料に限るべきか」を署名から判定する手がかりが無く、一律に要求すると実行不能な指示に
  // なる。そちらは規約とレビューで守る（この repo が繰り返し避けている形に倒さない）
  it('宣言したプラン機能はどれも route() の宣言を持つ', async () => {
    // 印から読み取った「ルートがゲートしている機能」の集合
    const gated = new Set<string>();
    for (const { full } of routeFiles) {
      // モジュールを読み込む（綴りではなく値を見る）
      const routeModule: Record<string, unknown> = await import(pathToFileURL(full).href);
      for (const method of HTTP_METHOD_EXPORTS) {
        // その名前を export していなければ何もしない
        const exported = routeModule[method];
        if (exported === undefined) continue;
        // 機能ゲートの印を読む
        const feature = (exported as unknown as Record<symbol, unknown>)[
          ROUTE_REQUIRED_PLAN_FEATURE_BRAND
        ];
        // 宣言があれば集合へ入れる
        if (typeof feature === 'string') gated.add(feature);
      }
    }
    // 表の全機能がどこかのルートでゲートされていること
    for (const feature of PLAN_FEATURES) {
      expect(gated, `プラン機能 ${feature} をゲートしているルートが無い`).toContain(feature);
    }
    // 1 つも読めていなければ印の読み取りか走査が壊れている（fail-closed）
    expect(gated.size, '機能ゲートを宣言した export が 0 件').toBeGreaterThan(0);
  });

  // **機能ゲートを持つルートもレート制限より前に認可する**（枠を持つなら）。
  // 理由は追加の枠と同じで、403 になる要求で枠を減らさないため
  it('機能ゲートを持つルートは枠を持つなら認可も宣言している', async () => {
    // 確かめた数
    let checked = 0;
    for (const { full, relativeToApp } of routeFiles) {
      const routeModule: Record<string, unknown> = await import(pathToFileURL(full).href);
      for (const method of HTTP_METHOD_EXPORTS) {
        const exported = routeModule[method];
        if (exported === undefined) continue;
        const brands = exported as unknown as Record<symbol, unknown>;
        // 機能ゲートを持たないルートは対象外
        if (typeof brands[ROUTE_REQUIRED_PLAN_FEATURE_BRAND] !== 'string') continue;
        // 枠を持たないルートは対象外（枠が無ければ消費される枠も無い）
        const tier = brands[ROUTE_RATE_LIMIT_BRAND];
        if (tier === null || tier === undefined) continue;
        checked += 1;
        expect(
          brands[ROUTE_REQUIRED_ACTION_BRAND] ?? brands[ROUTE_REQUIRED_ROLE_BRAND],
          `${relativeToApp} の ${method} は機能ゲートと枠を持つのに requiredAction / requiredRole を宣言していない`,
        ).not.toBeNull();
      }
    }
    // 1 つも見ていなければ走査が壊れている（fail-closed）
    expect(checked, '機能ゲートと枠を併せ持つ export が 0 件').toBeGreaterThan(0);
  });

  // 応答を返す前に通知の往復を待つ経路。連鎖からは中継と区別できないので個別に固定する
  // (ここを standard へ落とすと、外部の応答時間を乗せた要求を毎分 600 回出せる)
  it('通知の往復を待つ明示実行は outbound の枠で数えている', async () => {
    // 明示実行のルート
    const runRoute: Record<string, unknown> = await import('@/app/api/v1/guardrails/run/route');
    // POST の印が outbound であること
    const post = runRoute.POST as unknown as Record<symbol, unknown>;
    expect(post[ROUTE_RATE_LIMIT_BRAND]).toBe(RATE_LIMIT_TIER.outbound);
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

// 環境変数として読む秘密の名前 (パーサで識別子・文字列リテラルとして見るので、
// 末尾に続く別の定数 PLATFORM_ADMIN_TOKEN_MIN_LENGTH は最初から別のトークンになる)
const PLATFORM_ADMIN_TOKEN_NAME = 'PLATFORM_ADMIN_TOKEN';

// 認証のソース (秘密を実際に比べる唯一の場所)
const AUTH_SOURCE_PATH = join(process.cwd(), 'src', 'lib', 'api', 'auth.ts');

/**
 * 構文木の中で、秘密の名前に「コードとして」触れている位置を集める。
 *
 * 拾うのは識別子 (`process.env.PLATFORM_ADMIN_TOKEN` や分割代入) と
 * 文字列リテラル (`process.env['PLATFORM_ADMIN_TOKEN']`) の両方。
 *
 * **正規表現でコメントを落とす形に戻さない。** 以前は `//` から行末までを削っていたため、
 * コメントではなく**文字列リテラルの中の `//`** でも行末までが消えていた (実測:
 * `const docs = 'https://example.com'; const t = process.env.PLATFORM_ADMIN_TOKEN;` は
 * `const docs = 'https:` に切り詰められる)。つまり 1 行にそう書くだけで 2 つ目の
 * 読み取り箇所を全件緑のまま置け、そこで安い比較を書けてしまった。
 * パーサならコメントはトークンにならないので、説明文で名前を出すのは自由なまま
 * この取りこぼしだけが消える (tests/lib/source-files.ts の冒頭コメントと同じ理由)。
 */
function secretNameOffsets(source: ts.SourceFile): number[] {
  // 見つけた位置を溜める入れ物
  const offsets: number[] = [];
  // 構文木のすべてのノードを辿る
  forEachNode(source, (node) => {
    // 識別子か文字列リテラルで、綴りが秘密の名前そのものか
    const touches =
      (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
      node.text === PLATFORM_ADMIN_TOKEN_NAME;
    // 当てはまればソース上の位置を控える (関数の中かどうかを後で判定するため)
    if (touches) offsets.push(node.getStart(source));
  });
  // 見つけた位置をそのまま返す (件数と範囲は呼び出し側が判定する)
  return offsets;
}

/** 名前で関数宣言を探し、そのソース上の範囲を返す (見つからなければ null)。 */
function functionRange(source: ts.SourceFile, name: string): { start: number; end: number } | null {
  // 見つけた範囲 (最初の 1 つだけを採る)
  let found: { start: number; end: number } | null = null;
  // 構文木を辿って関数宣言を探す
  forEachNode(source, (node) => {
    // 既に見つかっていれば何もしない
    if (found !== null) return;
    // 関数宣言で、名前が一致するもの
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      // その関数がソース上で占める範囲を控える
      found = { start: node.getStart(source), end: node.getEnd() };
    }
  });
  // 見つからなければ null (呼び出し側が fail-closed で落とす)
  return found;
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
    // 認証のファイル以外では 1 度も現れないこと (別の場所で読めば、そこで安い比較を書ける)
    for (const { path, source } of parsedSources) {
      // 認証のファイルは下で中身を見る
      if (path === AUTH_SOURCE_PATH) continue;
      // コードとして触れている位置が 1 つも無いこと (コメントでの言及は数えない)
      expect(secretNameOffsets(source), path).toEqual([]);
    }
    // 認証のファイルを構文木にする
    const authSource = ts.createSourceFile(AUTH_SOURCE_PATH, auth, ts.ScriptTarget.Latest, true);
    // 照合の関数がソース上で占める範囲
    const range = functionRange(authSource, 'matchesPlatformAdminToken');
    // 読めなければ走査が壊れているので落とす (fail-closed)
    expect(range, 'matchesPlatformAdminToken の定義が読めない').not.toBeNull();
    // 認証のファイルで秘密に触れている位置
    const offsets = secretNameOffsets(authSource);
    // 走査が壊れて 0 件になったら落とす (「違反ゼロ = 緑」で無力化されないように)
    expect(offsets.length, '認証のファイルで秘密を読んでいる箇所が見つからない').toBeGreaterThan(0);
    // すべてが照合の関数の中にあること (関数の外へ出したら落ちる)
    for (const offset of offsets) {
      expect(
        range !== null && offset >= range.start && offset < range.end,
        `PLATFORM_ADMIN_TOKEN を照合の関数の外で読んでいる (位置 ${offset})`,
      ).toBe(true);
    }
  });

  /**
   * 受信 Webhook の署名の照合も定数時間比較を通すこと（Step6）。
   *
   * **これは綴りを見る弱い二次的な網**で、証明ではない（`Buffer.compare` や自前のループへ
   * 書き換えれば素通りする。実測でも素の `===` へ戻す変異は**この網を足す前は全件緑**だった）。
   * 署名の一致は観測可能な振る舞いに現れないので、テストで原理的に捉えられるのは綴りまで。
   * **本当の担保は規約とレビュー**（理由は docs/adr/0012-plans-and-billing.md）。
   */
  it('受信 Webhook の署名の照合は定数時間比較を通す', () => {
    // 署名検証のソース
    const signature = readFileSync(
      join(process.cwd(), 'src', 'lib', 'billing', 'signature.ts'),
      'utf8',
    );
    // node:crypto から定数時間比較を読んでいること
    expect(
      /import\s+\{[^}]*\btimingSafeEqual\b[^}]*\}\s+from\s+'node:crypto'/.test(signature),
      '定数時間比較を node:crypto から読んでいない',
    ).toBe(true);
    // 検証の本体を切り出す（書き方を変えたらここで気付く）
    const body =
      /export function verifyBillingSignature\([\s\S]*?\n\): BillingSignatureResult \{([\s\S]*?)\n\}/.exec(
        signature,
      )?.[1];
    expect(body, 'verifyBillingSignature の定義が読めない').toBeDefined();
    // 比較に定数時間比較を使っていること
    expect(/timingSafeEqual\(/.test(body ?? ''), '定数時間比較を使っていない').toBe(true);
    // 素の等価比較で署名を照合していないこと（早期終了すると一致長が応答時間から漏れる）
    expect(
      /signature\s*===|===\s*expected\b/.test(body ?? ''),
      '署名を素の等価比較で照合している',
    ).toBe(false);
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
