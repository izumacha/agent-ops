// `agentops_http_responses_total` が数えない応答の種類（既知の非可視）の表。
//
// **`src/lib/metrics.ts` から分けてある。** 本番のコードはこの表を 1 度も読まない
// （読むのは `tests/route-wrapping.test.ts` と `tests/docs-gate.test.ts` と、文書の目印）。
// あちらは `src/lib/log.ts` ← `src/domain/plan.ts` の連鎖で全 Route Handler・入口の proxy
// （毎リクエスト評価）・`prisma/seed.ts` へ入るので、同梱すると 2KB 近い日本語の説明文が
// すべての関数バンドルへ載る — `log.ts` 自身が「import を最小に保つ（実測で seed の
// import グラフが 9 ファイル増えた）」と書いている方針と向きが逆になる（§6 デッドコード）。
//
// **正本はこのファイル。** `metrics.ts` 側はここを名指しするだけで import しない。

/**
 * `agentops_http_responses_total` が**数えない**応答の種類（既知の非可視）。
 *
 * 数えるのは `src/app/**` の `route.ts` が export する関数の応答だけで、そこは
 * `withResponseCount` を通ること（`tests/route-wrapping.test.ts` が印から全数を要求）で
 * 漏れが出ない。**それ以外にも応答を返す経路がある**（下の鍵がその一覧で、ここが正本）。
 *
 * 以前は入口の 404 だけを「数えられない経路が 1 つある」と書いており、画面の描画と
 * Server Action が**1 件も数えられていないのに言及されていなかった** — 運用者が
 * 「他の HTTP 通信はすべてこの系列に乗る」と読め、ダッシュボードのログイン総当たりや
 * 描画中の 500 を警報の条件に書いても一度も発火しない（**件数は書かない** — 画面を 1 枚
 * 足すたびに数字だけが古くなる。実在することは下の検査が導出で確かめる）。
 *
 * **鍵はそのまま文書の目印。** `docs/deploy.md` と `docs/adr/0014-observability.md` が
 * `<!--uncounted:<鍵>-->` を持つことを `tests/docs-gate.test.ts` がこの表から導いて要求する
 * （散文だけに置くと、種類が増えたとき文書の側だけが古くなる。この穴がまさにそれだった）。
 * 種類が増えていないことは `tests/route-wrapping.test.ts` が `src/app` 配下の分類から確かめる。
 */
export const UNCOUNTED_RESPONSE_SOURCES = {
  // 入口（`src/proxy.ts`）が percent-decode できないパスへ返す 404。**数えようとしても
  // 見えない** — 入口は Route Handler とは別のモジュール実体で評価されるため（本番ビルドで
  // 実測: health の 200 は `/metrics` に現れるのに、入口の 404 は 2 件とも現れなかった）。
  // 数えたように見えて見えない形は作らず、ログだけで非可視を解いてある
  // （`entry.undecodable_path`。1 プロセスに 1 度だけ。**その行の数も同じ理由で
  // `agentops_log_events_total` には現れない**）
  entryProxy: '入口 (src/proxy.ts) の短絡（別モジュール実体なので数えようとしても見えない）',
  // 画面の描画（`src/app` 配下の `.tsx`）。Next.js は描画の応答を Route Handler として
  // 扱わないので、包む場所がそもそも無い（`error.tsx` の 500 も同じ）
  pageRender: '画面の描画 (src/app 配下の .tsx)。包める入口が無い',
  // Server Action（`'use server'` のモジュール）。POST で届くが Route Handler ではないので
  // 同じく包めない。**ログイン失敗はログに出す**（`session.login_rejected` /
  // `session.cross_origin_action`）ので、総当たりは警報の条件に書ける＝ただし条件は
  // ログ側の `event` で、この系列ではない
  serverAction: "Server Action ('use server' のモジュール)。包める入口が無い",
  // **包む側が投げ直した Next.js の制御フローの例外から Next.js が組み立てる応答。**
  // `redirect()` / `notFound()` / `forbidden()` / `unauthorized()` は Route Handler の中から
  // でも投げられ、`withResponseCount` はそれを**応答へ写さず投げ直す**（写すと遷移も 404 も
  // 起きず 500 の JSON になる）。応答を作るのは Next.js なので、こちらには数える場所が無い。
  // いま投げている経路は 1 本も無いが、画面側の CSV を `currentSession()` から
  // `requireSession()` へ寄せる 1 行の整理で生まれる（`response-count.ts` がその例を挙げている）
  nextControlFlow: 'Route Handler から投げた Next.js の制御フローの例外（応答は Next.js が作る）',
  // **Next.js がルートの代わりに組み立てる応答**（実測）。export の無いメソッドへの 405 と、
  // 自動実装される `OPTIONS` の 204 がこれ。本番ビルドで `PUT /api/v1/health` → 405・
  // `DELETE /api/v1/metrics` → 405・`OPTIONS /api/v1/metrics` → 204 を叩いてから `/metrics` を
  // 読むと、3 件とも系列に 1 つも現れなかった（`auto-implement-methods` が応答を作るので
  // ラッパーを通らない。同じ理由で `no-store` も `Vary` も付かない — ただし 405 は本文が無く、
  // `OPTIONS` は `allow` だけなので、テナント固有の内容は漏れない）。
  // **メソッド総当たりの 405 の急増は、この系列では見えない**（前段のアクセスログで見る）
  frameworkSynthesized:
    'Next.js がルートの代わりに組み立てる応答（export の無いメソッドの 405・自動実装の OPTIONS）',
} as const;

/** 数えない応答の種類の名前（上の表の鍵） */
export type UncountedResponseSource = keyof typeof UNCOUNTED_RESPONSE_SOURCES;
