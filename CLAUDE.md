# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> このファイルの **§4 以降（共通規約 ＋ 付録）は原本テンプレート `izumacha/claude-code-rules` の
> `CLAUDE.md` と同期**している。共通規約を変更するときは、**まず原本を改訂してから**各リポジトリへ
> 反映すること（このファイルで共通規約だけを勝手に書き換えない）。§1〜§3 は本リポジトリ固有の内容。
>
> **正本（Source of Truth）は `docs/spec.md`（仕様）と `docs/roadmap.md`（ロードマップ・受け入れ基準）。**
> 実装と衝突したら先に文書を改訂してから実装を変える。設計判断は `docs/adr/` に ADR として残す。

---

## 1. プロジェクト概要

Agent Ops — AI エージェントの**登録・権限・コスト・品質・停止**を一元管理する運用基盤（SaaS）。Next.js 16 + Prisma 7 + PostgreSQL 16（Docker）。UI テキスト・エラーメッセージ・テストの説明文は日本語で、編集時もそれを保持する。

開発は `docs/roadmap.md` の 8 Step（0 設計・骨組み → 1 台帳・権限 → 2 コスト計測プロキシ → 3 品質評価 → 4 ガードレール・停止 → 5 ダッシュボード → 6 マルチテナント・課金 → 7 リリース準備）で進める。**各 Step の受け入れ基準は `npm run gate:stepN` として自動化し、`main` でゲートが緑になってから次 Step のブランチを切る。** Step の順序を入れ替えず、後 Step の機能を前 Step に混ぜない。基準を緩める変更は `docs/roadmap.md` と該当 ADR を同じ PR で更新する（テスト側だけを書き換えない）。検証はすべてローカル＋CI で完結させる（人手の営業・ヒアリングは含めない）。

現在の段階: **Step2（コスト計測プロキシ）実装済み**（`npm run gate:step2` 緑）。次は Step3（品質評価）。

## 2. コマンド

```bash
npm run dev          # Next.js dev server (http://localhost:3000)
npm run build        # 本番ビルド（Docker 用 standalone 出力）
npm run typecheck    # tsc --noEmit
npm run lint         # eslint . (ESLint 9 flat config + next/core-web-vitals)
npm run format       # Prettier で整形 (100 col, single quotes, trailing commas)
npm run format:check # Prettier の検査だけ (ゲートが実行する。書式の崩れは lint / typecheck / test では拾えない)
npm run test         # Vitest — tests/**/*.test.ts のユニット・API テスト（DB 不要。契約テストは RUN_PRISMA_CONTRACT 無しではスキップ）
npm run test:contract # prisma アダプタの契約テスト（RUN_PRISMA_CONTRACT=1 と専用 DB の DATABASE_URL が必須。全テーブル TRUNCATE）
npm run gen          # OpenAPI (openapi/openapi.yaml) → src/generated/openapi.d.ts
npm run db:generate  # Prisma クライアントを src/generated/prisma に再生成
npm run db:migrate   # prisma migrate dev
npm run db:deploy    # prisma migrate deploy（CI / コンテナ起動時）
npm run db:seed      # prisma db seed（実行内容は prisma.config.ts の migrations.seed が唯一の定義）
npm run gate:step0   # Step0 の受け入れ基準を一括検査（gen / db:generate / lint / format:check / typecheck / test / OpenAPI / ADR）
npm run gate:step1   # Step1 の受け入れ基準を一括検査（gate:step0 の項目 + テスト 60 件以上 pass / RBAC 3×3 の全パターン pass / npm audit high 0）
npm run gate:step2   # Step2 の受け入れ基準を一括検査（gate:step1 の項目 + 料金計算が料金表の全モデル分 pass + 本番ビルド + ベンチ 2 本）
npm run bench:usage  # ベンチ: 1 万件投入で日次集計 ≦ 1 秒（専用 DB が必須。全テーブルを TRUNCATE する）
npm run bench:proxy  # ベンチ: プロキシ経由の追加遅延 ≦ 50ms（先に npm run build。専用 DB が必須）
npx tsx scripts/issue-user-token.ts --email admin@example.com  # seed 済みユーザーにログイントークンを発行（開発用 CLI）
```

個別実行: `npx vitest run tests/rbac.test.ts` / `npx vitest run -t 'fail-closed'` / `npx vitest run tests/api/agents.test.ts`。

契約テストをローカルで流すときは専用 DB を切る（開発 DB を指さない）:

```bash
docker compose exec db psql -U postgres -c "CREATE DATABASE agent_ops_contract;"  # 初回のみ
docker compose exec db psql -U postgres -d agent_ops_contract -c "CREATE SCHEMA IF NOT EXISTS app;"  # 初回のみ
DATABASE_URL='postgresql://postgres:postgres@localhost:5432/agent_ops_contract?schema=app' npm run db:deploy
DATABASE_URL='postgresql://postgres:postgres@localhost:5432/agent_ops_contract?schema=app' RUN_PRISMA_CONTRACT=1 npm run test:contract
```

**`?schema=app` は CI と同じにする**（`.github/workflows/ci.yml` の契約ステップ）。既定の `public` だけで流すと、接続文字列の `?schema=` を**アダプタのオプションと `search_path` の両方へ反映する**結線が一度も試されない（この結線を外しても契約テストは緑のまま通る。`?schema=` 付きなら複数件が赤くなる）。手順を片方だけ変えると、同じ DB に対してもう一方の手順で接続したとき `relation "Tenant" does not exist` になる。

**契約テストの DB は共有状態**（`beforeEach` で全テーブルを `TRUNCATE`）。同じ DB へ 2 人が同時に流すと理由の分からない赤が出るので、並行して走らせるときは DB 名を分ける（接尾辞 `_contract` は保つ）。

セットアップ: `cp .env.example .env && docker compose up -d db && npm ci && npm run gen && npm run db:generate && npm run db:migrate && npm run db:seed`。アプリごと Docker で動かすなら `docker compose up --build`（`app` は起動時に `prisma migrate deploy` を実行する）。**クローン後・スキーマ変更後・OpenAPI 変更後は `npm run db:generate` / `npm run gen` を実行してから `typecheck` する**（`src/generated/` は gitignore の生成物）。

**ベンチ（`bench:usage` / `bench:proxy`）と `gate:step2` は DB を使う。** `DATABASE_URL` は契約テストと同じ**専用 DB（名前が `_contract` で終わる）**を指すこと — ベンチは全テーブルを `TRUNCATE` するので、開発 DB を指していれば 1 件も書かずに落ちる（判定は `scripts/lib/contract-database.mjs` の 1 か所）。ベンチが叩く上流はローカルに立てたスタブなので、**実際の Anthropic / OpenAI は呼ばず課金も発生しない**。

CI（`.github/workflows/ci.yml`）は `gate` ジョブ（ジョブ名＝ステータスチェック名は Step が進んでも変えず、実装済みの最新 Step のゲートを回す。どの Step かはステップ名で示す。Step2 からはベンチのため PostgreSQL サービスコンテナを持つ）、PostgreSQL サービスコンテナで `db:deploy` → `db:seed`（2 回流して冪等性確認）→ 専用 DB での契約テスト → `build` を行う `migrate-and-build` ジョブ、`docker compose up` で `/api/v1/health` が healthy になることを確かめる `docker-smoke` ジョブの 3 本。§14 の「PR 前に通すローカル検証」は `npm run gate:step2` と `npm run build`（ゲートは常に実装済みの最新 Step のものを回す。`docs/roadmap.md` ゲート運用ルール 2）。

**major 更新を意図的に保留している依存が 3 つある（`.github/dependabot.yml`）。**

- **`@types/node`（npm）と `node` ベースイメージ（docker）**: 型と出荷先のランタイムがずれても lint も typecheck もテストも通る（**CI の緑が判断材料にならない fail-open**）ので、「ランタイムを上げる判断」の側で一緒に上げる。解除条件は上流ではなく人の判断なので期限切れの検査は持たず、**保留そのものの消失・重複・効きすぎ**を `tests/dependabot-runtime-hold-guard.test.ts` が見る（解除の運用で消える eslint / typescript のガードとは別ファイルにしてある）。
- **`eslint` の 9 → 10**: `eslint-config-next` が引き込む `eslint-plugin-react` / `eslint-plugin-import` / `eslint-plugin-jsx-a11y` が peer で `^9` までに制限しており、10 では削除済み API を呼ぶため `npm run lint` が必ず落ちる。
- **`typescript` の 5 → 7**: lint の経路に載る `typescript-eslint` / `@typescript-eslint/*` が peer で `typescript >=4.8.4 <6.1.0` を、型生成の `openapi-typescript` が `^5.x` を宣言しているため、**`npm ci` が ERESOLVE で落ちる**（実測: Dependabot の PR #2 は gate / migrate-and-build / docker-smoke の 3 ジョブすべてがインストールの時点で失敗した）。

**どの `ignore` も消さず、`package.json` の版を手で上げない。** `eslint` / `typescript` の解除条件（上流が揃って次の major を許すこと）は `tests/dependabot-eslint-guard.test.ts` / `tests/dependabot-typescript-guard.test.ts` が **`package-lock.json` の解決済み `peerDependencies` から導いて**判定する（`package.json` の major を見る形では、保留が効いている限り値が動かないので解除条件が永久に発火しない）。**見張る依存も、判定に使う版も手書きしない** — typescript 側は「必須 peer で typescript を縛っている依存」と「解決済み版の次の major」をどちらもロックファイルから導く（0 件しか読めなければ fail-closed で落とす）。**候補の版を直書きすると保留の範囲より判定が狭くなる**: `ignore` はすべての major を止めるのに、判定だけが `7.0.0` を見ていると、6.x の保留理由（`openapi-typescript` の `^5.x` 1 件だけ）が消えても緑のままで 6.x が永久に抑止される。落ちたら**そのまま削除してよいとは限らない** — `ignore` はすべての major を止めているので、次の major だけが通るようになった状態で消すとさらに上の major が入って同じ ERESOLVE が戻る。失敗文言が上の major の状況まで出すので、「削除する」か「`versions` で範囲を絞る」かを見て決める。

`npm audit` の high 0 はゲートの一部。Prisma 7.10 の CLI が固定する推移依存（`deepmerge-ts` / `mysql2`）の high は `package.json` の `overrides` で解決版へ差し替えている（この API は PostgreSQL しか使わず、`mysql2` は実行時に到達しない）。**上流 (`@prisma/config` / `prisma`) はこれらを完全一致でピンしているので、`overrides` はそのピンを跨いで major を上げている**（現状 `prisma generate` / `migrate deploy` は動作を確認済み）。Prisma を上げて上流が解決版を取り込んだら `overrides` を外す。外す前に Prisma を大きく上げるときは、`overrides` を外した状態で `npm audit` と `prisma migrate deploy` の両方を確かめる。

## 3. アーキテクチャ

**スタック:** Next.js 16 App Router, React 19, TypeScript strict, Prisma 7 + `@prisma/adapter-pg` + PostgreSQL 16, Zod 4, Vitest, openapi-typescript。

### 正本と生成物

- `docs/spec.md` — ユースケース 10 件（`### UC-NN` 見出し）・ER 図（mermaid）・API 一覧。`tests/docs-gate.test.ts` が件数と節の存在を固定する。
- `docs/roadmap.md` — 8 Step の成果物・受け入れ基準・状態。`docs/adr/NNNN-*.md` — 設計判断（ステータス行必須）。
- `openapi/openapi.yaml` — REST API 契約（OpenAPI 3.1）。`npm run gen` → `src/generated/openapi.d.ts` → `src/lib/api-types.ts` がアプリ側の名前で再公開する。Route Handler の型はここから取り、生成物のパスを直接書かない。`tests/openapi.test.ts` が operationId の一意性・タグの宣言・認証が要る全オペレーション（GET 含む）の 403 宣言を固定する。**新しいエンドポイントは「定義 → `gen` → 実装 → API テスト」の順**（ADR-0003）。
- `prisma/schema.prisma` — 生成先は `src/generated/prisma`。**enum の正準は `src/domain/types.ts`**（`as const` で定義し Prisma の実行時コードに依存しない。Prisma 側の enum と一致することは `tests/domain-enums.test.ts` が固定する）。`@/generated/prisma` の直接 import は ESLint が禁止し、例外は結線箇所の `src/lib/prisma.ts` / `src/lib/prisma-client.ts` と prisma アダプタ `src/data/adapters/prisma/` だけ。マイグレーションは `prisma/migrations/`（初期は `prisma migrate diff --from-empty --to-schema` で生成。以降は Docker が無い環境でも `--from-schema <直前の schema.prisma> --to-schema prisma/schema.prisma --script` で差分 SQL を作れる）。

### Prisma 7 の結線

`PrismaClient` を直接 `new` せず、`src/lib/prisma-client.ts` の `createPrismaClient()` を使う（アプリの singleton `src/lib/prisma.ts`・seed・将来の契約テストがすべて経由する）。`src/lib/prisma.ts` の `prisma` は Proxy 経由の**遅延生成**で、DB を触らないユニットテストが import しただけでは接続文字列を要求しない。接続文字列と seed コマンドは `prisma.config.ts` に集約し、`.env` は Next.js 以外の入口（`prisma.config.ts` / `prisma/seed.ts`）が各自 `dotenv/config` で読む。`DATABASE_URL` 未設定は fail-closed で落とす。接続文字列の `?schema=` は**アダプタの `schema` オプションと接続時の `search_path` の両方**へ反映し、未指定なら `public` を明示的に固定する（片方だけだと Prisma CLI と実行時クライアントが別スキーマを向き、`SELECT 1` の生存確認は通るのに全クエリが落ちる）。

**生 SQL は「パラメータ化された形」だけに閉じる。** `createPrismaClient()` が返すクライアントは `src/lib/raw-sql-guard.ts` の `guardRawSql()` で包まれており、`$queryRawUnsafe` / `$executeRawUnsafe` は呼んだ時点で throw、`$queryRaw` / `$executeRaw` はタグ付きテンプレート以外の呼び方と、パラメータにならない値（`Prisma.raw` / `Prisma.sql` が返す SQL 断片）の埋め込みを拒否する。`$transaction` のコールバックが受け取るクライアントも同じ包みへ入れる（**実際に生 SQL を書いているのは行ロックのある `$transaction` の中**なので、そこを素通しにすると守るべき場所がまるごと外れる）。**この判定を静的解析へ戻さないこと** — 綴りを走査する検出網は 1 段の間接化で崩れ、実測では `const { raw } = Prisma` と分割代入して変数に入れた断片を埋め込むだけで、構文検査も ESLint も素通りし、URL のパスパラメータから任意 SQL を実行できた（`pg_sleep` が実際に効き、他テナントのユーザーの存在判定もできた）。`tests/raw-sql.test.ts` と ESLint の `no-restricted-syntax` は「危険な書き方が直接の綴りで増えたことに早く気付く」ための二次的な網で、証明ではない。ガードの挙動は `tests/raw-sql-guard.test.ts` が、本番クライアントへの結線は契約テストが固定する。**閉じるのは「包んだクライアントから**通常のプロパティ読み取りで**値を取る経路」だけ** — Proxy のトラップは `get` 1 つなので、**プロパティの読み取り以外の内省は包まれない**。守備範囲の外は 2 つあり、どちらも実測済み: **(1) プロトタイプ経由**（`Object.getPrototypeOf(guarded).$queryRawUnsafe.call(client, sql)`。生成物の `PrismaClient` は生 SQL のメソッドを**プロトタイプ上**に持ち、`src/lib/prisma.ts` の遅延生成 Proxy も `getPrototypeOf` を実体へ転送する。`getPrototypeOf` トラップで包み直すことはできるが、**返すのが別オブジェクトになるため `instanceof` が成立しなくなる**ので意図的に開けてある。`Object.getOwnPropertyDescriptor(guarded, name).value` も同じ）、**(2) 2 つ目のクライアントを作る経路**（`new PrismaClient(...)` や `new (prisma.constructor)(...)`）。どちらも追いかけると綴りを追う形に戻るので追わず、「クライアントの生成は `createPrismaClient()` だけ」という規約・二次的な静的の網（`tests/raw-sql.test.ts` と ESLint は**レシーバを問わず** `$queryRawUnsafe` / `$executeRawUnsafe` の綴りを落とすので、(1) の素直な書き方はそこで赤くなる＝実測）・レビューで守る。**「このガードがあるから生 SQL は必ずパラメータ化される」と読み切らないこと。** 境界そのものは `tests/raw-sql-guard.test.ts` が固定しているので、閉じ方を変えるときはそちらも直す。

### レイヤ構成

- `src/proxy.ts` — 全リクエストの入口（Next.js 16 の `proxy` ファイル規約。旧 `middleware.ts` の後継で**エクスポート名は `proxy` 固定**）。パスの percent-decode に失敗する要求（`/api/v1/agents/%ff` 等）を 404 で落とす — Next.js が `params` を組み立てる `decodeURIComponent` は `route()` の try/catch より手前なので、素通しすると**認証ヘッダ無し**で動的セグメントを持つ全ルートが素の 500 を返す（実測）。`TRACE` などの未対応メソッドはこの proxy にも到達しないので、前段のリバースプロキシで落とす前提（ADR-0005 の宿題）。**proxy を置くと Next.js は非 GET の本文を入口でバッファし、`experimental.proxyClientMaxBodySize` を超えた分を黙って切り詰める（エラーにしない）。** このバッファは**認証より前**に走るので、既定（10 MiB）のままだと未認証の相手が 1 接続あたりその分のヒープを握れる。そこで `next.config.ts` は値を `src/lib/body-limits.ts` の `ENTRY_MAX_BODY_BYTES`（= `JSON_BODY_MAX_BYTES` ＋ 余白）から**導出**する（数値を書き写さない）。**余白は「1 回のソケット読み取り以上、その 2 倍以内」に保つ**（`MAX_SOCKET_READ_BYTES`。いまの値は下端ちょうど）— Next.js は上限を跨いだかたまりを**丸ごと捨てて**閉じるので、余白が小さすぎると切り詰め後の長さがアプリの上限ちょうどに着地して 413 をすり抜け、**先頭が完結した別の妥当な JSON** だと 201 が返って送信者の書いた項目を落とした資源が黙って作られる（実測）。大きすぎると未認証に握らせるヒープが戻る。両方向を `tests/proxy.test.ts` が固定し、**基準は `node:stream` から実測した読み取り単位**から取る（定数どうしで比べると恒真式になり、写しを縮める変異が素通りする）。実測値の記録は `src/lib/body-limits.ts` に置く（数値の写しを増やさない）。`body-limits.ts` は `next.config.ts` が import するので**定数だけを持ち import を持たない**（Next の config transpile は `next.config.ts` 自身の import しか `paths` を書き換えず、連鎖に `@/...` が残ると `npm run build` だけが落ちる）。**サイズだけでは資源の消費を縛れないので、入れ子の深さにも上限を置く**（`JSON_BODY_MAX_DEPTH`。超過は 422 で、判定は本文を読む共通の入口 `readJsonBody` にあるので**本文を取る全ルートに等しく効く**）。`JSON.parse` は深さ 10 万でも通るのに `JSON.stringify` は約 4,164 で RangeError になり、しかも落ちなくても深い構造の stringify 自体が重い — 上限が無かった頃は 8.4 KiB の本文 1 通で 6.4ms を焼いたうえ RangeError が 500 になっていた（いまは 0.33ms の 422）。**しきい値を上げる変異は「本文の上限まで詰めたフィクスチャ」で気付く**（位置の打ち切り・キーの打ち切り・訪問回数の予算・**同時に積む枝の数の予算**）。フィラーは**攻撃者と同じ密度**まで詰める — 疎なフィラーだとその比のぶん窓が開いたままで、実測で訪問予算 26,000 とキー数 7,000 の変異が全件緑を通った。**番兵はフィラーの文字集合の外から採る** — キーが衝突すると `JSON.parse` の重複キーは「値だけ後勝ち・位置は初出のまま」なので深い値が意図より手前へ落ち、実測では「最後のキー」のつもりが 8 倍手前（1,015 番目）で、`Object.keys(...).slice(0, 8_000)` が全件緑を通った。**フィクスチャの意図と実体の乖離は判定側の変異が無いと永久に見えない**ので、位置そのものも別に固定する。**同時に積む枝の数**は `[],` を並べる形が最密（3 バイト/節点＝21,800 本）で、数値や 1 本の鎖で埋めた版では 575 件しか積まれず、`if (stack.length > 2_000) return false;` が全件緑を通った。**ただしこれは証明ではない** — 位置の偶奇・部分集合・間引き（`index += 2` 等）はしきい値ですらないので原理的に列挙できず、実測でも深い値の位置がすべて偶数添字だった時点で 1 文字の変異が全件緑を通った。**「この族は閉じた」と書かない**。**値そのものは `tests/body-depth.test.ts` が上下から縛る** — RangeError の余裕（`< 3,000`）だけを見ていた版では、上限を 2,999 に上げても全件緑・件数も不変のまま「上限ちょうどの本文」が 33.4ms に戻せた（実測）。いまはコスト側の上限（`<= 128`）で押さえ、上げる差分は実測を取り直してレビューで確認する。**残る境界は 2 つ**: 深さを数えるのは `JSON.parse` の後なので 422 に倒す本文でも解釈の費用は払う。また**幅では同じことができる**（64 KiB に短いキーを詰めた本文は、上流も記録も無しで 1 通 3.3ms＝典型的な本文の約 31 倍。実測値と Step4 への申し送りは ADR-0007）。**残る境界: 保持時間は設定では直らない** — `Content-Length` を大きく宣言して 1 バイトずつ送ると Node 既定の `requestTimeout`（300 秒）まで 1 接続を占有できる（実測 305 秒）。本文のサイズとタイムアウトは前段のリバースプロキシでも落とす前提（ADR-0005 の宿題）。
- `src/app/*` — App Router。API は OpenAPI の `servers.url`（`/api/v1`）に合わせて `src/app/api/v1/*` に Route Handler として実装する。`api/v1/health/route.ts` は DB 到達性を返す（compose の healthcheck が使う）。**それ以外の Route Handler はすべて `src/lib/api/handler.ts` の `route()` で包む**（認証 → 本体 → 例外の HTTP 化を 1 か所に集める。`NextResponse` ではなく素の `Response.json` を返すので、テストは HTTP を介さずハンドラを直接呼べる）。本体の定型: `requireAction(principal, 'view'|'execute'|'stop')` / `requireAdminRole` / `requirePlatformAdmin` で認可 → `readJsonBody(request, schema)` で本文 → `repos.<port>` をテナント id 付きで呼ぶ → `serializers.ts` で DTO に写す。他テナントの id は `notFoundError()`（404）。**`route()` は本体へ渡す前に URL の動的セグメントを資源 id の形（`src/domain/resource-id.ts` の `isResourceId`）で検証し、形が違えば 404 にする** — Next.js はパスセグメントを percent-decode して渡すので、`/agents/%00` は NUL を含む文字列として届き、素通しすると PostgreSQL が拒否して 500 になる（実測。viewer のトークンだけで無制限に 500 とスタックのログを積める）。**この壊れ方は API テストからは見えない** — memory アダプタでは「表に無い」だけなので同じ入力が 404 に見える（ADR-0006 の構造的な死角）。判定はルートごとではなく `route()` に置くので、新しい `[id]` を足すときに書き足す場所は無い。
- `src/data/` — **Ports & Adapters**（ADR-0006）。契約は `ports/`（レコード型も Prisma 非依存）、本番は `adapters/prisma/`（Prisma を直接 import してよい唯一の場所）、テストは `adapters/memory/`。Composition Root は `index.ts` の `getRepos()`（async。prisma アダプタと singleton は動的 import で初回だけ読み、静的 import で生成物 `src/generated/prisma` を API テストの経路に引き込まない）で、テストは `setReposForTesting()` で差し替える（`NODE_ENV=production` では throw）。新しいエンティティ操作は「Port → memory → prisma → API テスト → 契約テスト」の順で足す。一意制約違反は `DuplicateError` に翻訳（→ 422）、削除の可否は `'deleted' | 'not_found' | 'restricted'` の戻り値（→ 204 / 404 / 409）、役割変更・無効化は `UserMutationResult`（`ok` / `not_found` / `last_admin` / `disabled` → 200 / 404 / 409 / 409。`disabled` は無効化済みユーザーの役割変更の拒否で、無効化そのものは冪等なので返さない）。トークン発行は `UserTokenCreateResult`（`ok` / `not_found` / `disabled` → 201 / 404 / 409。発行先の存在と有効/無効の判定もアダプタが挿入と同じトランザクションで行い、prisma は発行先ユーザー行の `FOR NO KEY UPDATE` で無効化と直列化する）。**「最後の有効な admin を降格・無効化しない」判定は API 層ではなくアダプタが更新と同じ原子的操作の中で行う**（prisma はテナント行の `FOR NO KEY UPDATE` で同一テナントの要求を直列化。子テーブル INSERT の FK 検査（`FOR KEY SHARE`）とは衝突させない。API 層で count → update と分けると 2 人の admin が互いを同時に降格して 0 人になる。**ロックの存在は契約テストが決定的に固定する** — 別トランザクションで同じテナント行を掴んだまま降格を始め、待たされることを確かめる。並行要求を 2 本投げるだけのテストは実際には直列に流れるので、ロック句を落としても緑のまま通る）。一覧は `createdAt → id` 順。**カーソルは最終行の `(createdAt, id)` を符号化したキーセット**（`src/data/page.ts` が唯一の定義。API 層は `decodeCursor` で 1 回だけ復号して `PageQuery.cursor`（`CursorKey`）に渡し、形が違えば 422。アダプタは位置の比較 `(createdAt, id) > key` を where に AND する）。行 id をカーソルにしない（Prisma の `cursor` 引数は where と AND しないため他テナントの id で先頭行が飛び・存在が漏れ、行が削除されると続きが取れない）。更新は `findById` → `update` の 2 往復にせず、複合一意 `(tenantId, id)` の `update` 1 回で P2025 を null に翻訳する（`updateOrNull`）。失効の冪等性は `updateMany({ where: { ..., revokedAt: null } })` の条件付き更新で表す（無効化の冪等性は上の最後の admin 判定と同じトランザクションの中で「既に無効なら書き換えない」として表す）。
- **プロキシ（Step2）** — `src/app/api/v1/proxy/*` は `route()` に `auth: 'apiKey'` を渡して**API キー（`aop_k_`）だけ**を受け付ける（ユーザートークンでは 401。ADR-0007）。本体は `proxy-route.ts` のファクトリ 1 つで、プロバイダごとの違いは `src/lib/proxy/upstream.ts`（接続先・ヘッダ・タイムアウト）と `src/lib/proxy/usage.ts`（トークン数の項目名）に閉じる。**接続先はコードと環境変数だけから決まり**、クライアントの本文・ヘッダ・パスは影響しない（§9 SSRF）。許可は https か**非本番の**ループバック http だけで、資格情報付き URL・クエリ付き・リダイレクト追従は拒否する。上流の資格情報はサーバ側の環境変数から取り、クライアントの `Authorization` は転送しない。**料金表に無いモデルは中継しない（422）** — 0 円の行を作ると請求の根拠が壊れる。成功も失敗も `UsageEvent` を 1 行記録し（失敗はトークン 0・料金 0・実際の `statusCode`）、**記録の失敗は中継を止めない**。上流の 2xx はそのまま返す。**ステータスを保って中継する 4xx は許可リストの 400 / 413 / 422 だけ**で、それ以外（402 / 404 / 409 …）は 502 に写す — 本文を定型文にしても**番号そのもの**が共有している上流アカウントの状態を語る（402 は支払いの滞り）。拒否リストだとベンダーが新しい番号を使った瞬間に漏れるので許可リストにしてある（§9 fail-closed）。中継する 4xx も**本文は機械可読な項目（`error.type` / `code` / `param` と最上位 `type`）に絞る** — 自由記述には残高・組織名・契約ティアが載る。絞り込みの規則は `src/lib/proxy/error-body.ts` で、**項目ごとに綴りを分ける**（1 本にまとめると `param` 用のドットが `type`/`code` にも効き、区切り文字で書いた文が素通りする）。**許す文字の negative control は「禁止文字を 1 つだけ混ぜた値」を文字ごとに総当たりする** — 既存のケースは `'quota for org-ACME exhausted; plan=Enterprise'` のように禁止文字を複数含んでいたため、どれか 1 つが漏れても他の文字が落としてしまい、実測で `[A-Za-z0-9]` に空白を 1 文字足すだけで 116 件すべて緑になり `'Your credit balance is too low'` が 3 項目すべてに載った（`:` `=` `,` `/` `$` も同じ。ハイフンだけは既存のケースが単独で落としていた）。いまは許可文字の表から「印字できる ASCII のうち許していない文字」を導いて 1 文字ずつ当てる。401 / 403（→ 502）と 429（そのまま）は写像の表 `UPSTREAM_STATUS_MASKING` が扱い、**`Retry-After` を中継してよいかも表が持つ**（429 だけ。値は整数の秒数の形だけ通す）。5xx は 502、時間切れは 504、設定不足は 503。**上流の本文が JSON として読めなければステータスに関わらず 502**（HTML のエラーページ・本文を持てない 204/304・上限超過。`Content-Type` では判定しない — 前段が付け替えただけの正しい JSON を捨てると「課金だけして捨てる」経路になる）。上流の応答本文にも上限を置く（`UPSTREAM_MAX_RESPONSE_BYTES`）。数えながら読む処理は `src/lib/stream-bytes.ts` がリクエスト本文と共有するが、**写像先の HTTP エラーと「上限超過で下層を解放するか」は呼び出し側が選ぶ**（リクエスト本文側で解放すると 413 が届く前に接続が切れ、上流側で解放しないと ソケットと fd がタイムアウトまで滞留する — 事情が正反対）。**503 のときは記録しない**（上流へ 1 バイトも出ていない呼び出しを記録すると、未設定のあいだ有効なキー 1 本で DB の行だけを無制限に増やせる）。**残る境界は ADR-0007 決定 7** に記載。ストリーミングは Step2 の範囲外で 422。**本文だけは `z.strictObject` にしない**（ベンダーのペイロードなので未知キーを通す。`tests/openapi.test.ts` の除外表に理由付きで 1 件だけ登録してある）。
- `src/domain/` — Prisma/Next 非依存の純粋ロジック（`npm run db:generate` 無しでもユニットテストが動く）。`rbac.ts` の許可表 `PERMISSIONS`（`viewer` / `operator` / `admin` × `view` / `execute` / `stop`）が**唯一の真実の源**で、`canPerform(role, action)` は未知の値を拒否する（fail-closed）。`tests/rbac.test.ts` が 9 パターンを、`tests/api/rbac-matrix.test.ts` が API 経路で同じ 9 パターン（テスト名 `RBAC 行列: <役割> × <操作>` は `scripts/gate-step1.mjs` が照合するので変えない）を固定する。`money.ts` はマイクロ USD の文字列 → BigInt 変換（BIGINT の範囲外は null）と、単価の 10 進 USD → マイクロ USD 変換（小数 6 桁を超える値は拒否。丸めると「誤差 0」が崩れる）。**料金の単価の正本は `src/domain/pricing/vendor-prices.json`**（出典 URL と取得日つき）で、`pricing.ts` はそれを読んで**すべて BigInt で**計算し端数を切り上げる（未知モデルは null）。壊れた行は読み込み時に例外で落とす（黙って読み飛ばすと「未対応モデル」に化けて原因が見えない）。日次集計の期間の規則（UTC の日境界・上限日数）は `usage-window.ts` が持ち、API と両アダプタが共有する（ADR-0008）。`resource-id.ts` の `isResourceId` が**資源 id の形の唯一の定義**で、パスセグメント（`route()`）・本文の id（`src/lib/validations/common.ts` の `resourceId`）・カーソルに符号化された id（`src/data/page.ts`）がすべてここを引く（規則の写しを作らない）。
- `src/lib/` — 横断インフラ: `describe-error.ts`（**エラーをログへ落とす形の唯一の定義**。`src/lib/api/` ではなく直下に置くのは、ストリーム読み取りやプロキシの記録経路も通す必要があり Route Handler の機構を引き込まないため。`console.error` の実引数で例外に触れるものは必ず `describeError()` を通す — 素の `error` や `error.message` は ORM の検証エラーならクエリ引数＝PII を、pg のプールエラーなら接続情報をそのまま流す。経路ごとに書き分けた版は実測で全件緑のまま通ったので、`tests/error-logging.test.ts` が構文で見張る）/ `prisma.ts`（遅延生成 Proxy。転送できる操作はすべて実クライアントへ転送し、bind した関数は同一性を保つ）/ `prisma-client.ts` / `pg-search-path.ts`（`search_path` の引用規則。`tests/pg-search-path.test.ts` が固定）/ `constants.ts`（UI 文言・enum ラベル・API の上限値と日本語エラー文言 `API_MESSAGES`。Route Handler に文言を直書きしない）/ `api-types.ts` / `tokens.ts`（トークンの生成・SHA-256・定数時間比較。接頭辞 `aop_u_` = ユーザートークン、`aop_k_` = API キー）/ `api/`（`auth.ts` 認証・`guard.ts` 認可・`body.ts` 本文検証 415→413→400→422（本文はストリームを上限バイトまでで打ち切って読む。`Content-Length` を偽る/省く要求にも効く）・`pagination.ts`・`serializers.ts`・`handler.ts`・`errors.ts`・`http-status.ts`（HTTP ステータス数値の唯一の参照元））/ `validations/`（Zod 4 スキーマ。**本文のスキーマは `z.strictObject` を使い、OpenAPI 側も `additionalProperties: false` を宣言する** — 未知キーを黙って剥がすと「PATCH に status を入れたのに何も起きない」という無言の無視になる。項目の一致・両側の厳格さ・長さ上限は `tests/openapi.test.ts` が契約側から導いて固定する）。
- `scripts/bench-*.ts` — 受け入れ基準のうち時間を測るもの（プロキシの追加遅延・1 万件の日次集計）。**しきい値は `scripts/lib/step2-criteria.mjs` が唯一の定義**で、`tests/docs-gate.test.ts` が `docs/roadmap.md` の Step2 行の散文と突き合わせる。プロキシのベンチは**逐次（1 接続）で測る** — 全力で流すと待ち行列が伸び、測れるのは追加遅延ではなく 1 プロセスの処理能力になる（実測: 全力 72ms / 毎秒 50 件に制限しても autocannon 自身のペース配分が混ざって 166ms / 逐次 10ms）。測る percentile は p97.5（autocannon は p95 を出さないので、より厳しい側で見る）。**判定の前に捨て玉（既定 200 件）を流す** — 起動直後の十数件だけが桁違いに遅い初回コスト（ルート読み込み・Prisma の接続確立・TLS 確立）は「中継 1 件あたりの増分」ではないため。混ぜると遅い機械ほど窓に入る件数が減って上位 percentile が押し上がり、同じコミットが機械によって合否で割れる（実測: 開発機 1358 件で p97.5 12ms・合格／CI ランナー 606 件で p97.5 155ms・不合格）。**上限も percentile も追加遅延の定義も変えていない**。捨てた側の分布も結果の JSON に出す。理由の正本はスクリプト冒頭のコメント。**ベンチ本体は計測して結果 (payload) を返すだけにし、判定・出力・終了コードは `scripts/lib/bench-criteria.mjs` の `runBench(ラベル, 計測)` が持つ** — 判定に渡す値は**結果の JSON に載せる値そのもの**（`BENCH_CRITERIA` が項目名で指す）から読むので、基準を騙すには出力する数字を偽るしかない。分けていた頃は継ぎ目のどれも 1 行で外せた（いずれも実測で全件緑・件数も不変）: 判定の結果を渡さない／実測値の代わりに定数を入れた変数を渡す／`process.exitCode = 1` の 1 行を消す（`passed: false` を出したまま exit 0 になり、ゲートは終了コードしか見ないので緑）。結線は `tests/gate-scripts.test.ts` が**トップレベルで実行するのは `requireContractDatabase` → `runBench` の 2 つだけ**（順番込み）・トップレベルに条件や `try` を置かない・`process.exit` / `process.exitCode` に触らない、まで求める（呼び出しの有無だけを見ていた頃は、手前に `if (!process.env.X) process.exit(0);` を 1 行足すだけで素通りした）。基準を足したら `BENCH_CRITERIA` に項目を書くだけでよく、挙動は同テストが表から導いて上下両側で固定する（計測が成立したかを見る門番 — 2xx 以外の件数・最小件数・捨て玉 — も同じ表に入れる。本体に `if (…) throw` として残すと、その 1 行を消しても検出網に映らない）。**`runBench` は計測結果を 1 回だけ写し取ってから判定と出力の両方に使う** — 写さずに 2 回読むと、getter を仕込むだけで判定と出力に別の値を返せた（実測）。読むのは自前の項目だけ（継承した項目は「無い」＝失敗に倒す）。**ゲートはベンチの終了コードだけでなく結果の JSON も読む**（`scripts/lib/gate-report.mjs` の `benchOutputProblems`）— 終了コードだけを見ていた頃は「何も出さずに exit 0」にする変異がどれも緑で通った（実測 3 通り）。見るのは、そのラベルを名乗る結果がちょうど 1 本あること・`passed`・**受け入れ基準の上限との比較（独立に比べるのはこの 1 本だけで、計測が成立したかの門番はベンチ側の `passed` を信じている。そちらは negative control が担保する）**で、**上限は受け入れ基準の正本（`step2-criteria.mjs`）からゲートが渡す**（ベンチの出力から読むと比較の両辺が同じ出力に由来し、`limitMs` を 100 倍にするだけで基準が 100 倍に緩んだ）。出力に載る `limitMs` が正本と食い違っていれば落とす。**この結線自体もラベルごとに見張る** — 見張っていなかったときは、ゲートからベンチの検査を丸ごと外しても赤が 1 件も出なかった。ベンチ本体では `process` の純粋な読み取り以外・トップレベル初期化子での副作用・リテラルでも識別子でもないトップレベルの実引数を禁じ、import 先は相対・非相対とも許可リストで絞る（どれも「専用 DB のガードより前に何でも走らせられる」形で、実測で全件緑のまま素通りした。とくに `node:*` をまとめて許すと `import { exit } from 'node:process'` が、実引数を見ないと `requireContractDatabase(副作用のある関数())` が通る）。**共有モジュールが import しただけでプロセスを終わらせないこと**は、vitest の印を外した子プロセスで実際に import して確かめる（同じプロセスでは「テストのときだけ通す」1 行を見逃す）。**`scripts/` の静的検査は「増えたことに気付く網」であって証明ではない** — 捉えられない形は `tests/lib/script-files.ts` の JSDoc が列挙している（許可リストに載せた呼び出し先の本体、ベンチが取り込むモジュールの import 時の副作用、遅延 exit など）。**基準が本当に強制されているかの担保は negative control が持つ**: vitest の印と `NODE_ENV` を落とした子プロセスで `runBench` に**全基準を 1 本ずつ破る**実測値を実際に通し、`passed: false`・非 0 終了・**実測値がそのまま出ること**を確かめる（最初の 1 基準だけを破っていたときは、残りの判定に `if (process.env.NODE_ENV === 'production') return null;` を入れても全件緑だった）（これが無いと、共有モジュールに `if (process.env.NODE_ENV !== 'test') payload.slowestMs = 0;` を 1 行入れるだけで受け入れ基準が完全に無効化されるのに全件緑だった）。ゲートと共有モジュールにも、ベンチと同じく `process` の使い方と import 先の**許可リスト**を掛け、加えて `process.exit` の実引数は**非 0 の数値リテラルだけ**を許す（綴りを並べる形に戻したときは `process['exit'](0)` や副作用モジュールの 1 行 import でゲート全体が無言で成功終了し、CI も緑のままだった）。**`process` へ届く経路は「綴りを並べる」だけでは閉じない。** 綴りを 1 つ塞ぐたびに次の形が出た（いずれも実測で全件緑・件数も不変のままゲートを無言の no-op にできた）: `globalThis.process` → `globalThis['process']` → `const g = globalThis; g.process` → `globalThis.globalThis.process`（`globalThis.globalThis === globalThis`）→ `const k = 'process'; globalThis[k]`。**そこで数えるものを「届いた形」から「静的に追えなくなった地点」へ変える** — グローバルオブジェクトの識別子は、その先が `process` として読めるか、あるいは**代入の左辺**（`globalThis[MARKER] = true` の印。値がそこから外へ出ない唯一の形）のときだけ免除し、それ以外は `'globalThis'` という使い方として数えて許可リストで落とす。**免除を「さらに辿る・呼ぶ形でなければ」にしてはいけない** — 値は変数宣言・括弧・実引数などあらゆる式の文脈から外へ出られるので、`const R = globalThis.globalThis;` と 1 ホップ挟むだけで塞いだはずの 2 系統が戻った（実測）。**「土台なら免除」にしてはいけない** — 追えるのは 1 ホップだけなので、2 ホップ以上や読めない添字がまるごと視界から消える。同じ理由で、**`process.exit` を呼ばずに取り出した形**（`.call` / `.apply` / `.bind(…)()` / `Reflect.apply` / 別名束縛）は実引数を非 0 に縛る検査が読めないので別の使い方として数え、**`eval` / `new Function`** も「そこで追えなくなる組み込み」として同じ枠で落とす。**許可の範囲は走査済みの集合から導く** — import の許可が `scripts/lib/` の前方一致だった頃は、走査が直下 1 段だったときの `scripts/lib/sub/`、拡張子 `.mjs` で絞っていたときの `scripts/lib/preflight.js`（`type` 宣言が無いので CJS）がどちらも「許可されるのに一度も見られない」状態で、そこへ `process.exit(0)` を置いて取り込むだけで素通りした（実測）。ベンチがアプリ本体から取り込む先も同様で、「`src/` の下なら許す」では偽の合格 payload を出すモジュールを新設するだけでベンチを走らせずに基準を通せたため、結線ごとの許可リスト（実在チェック付き）にしてある。**それでも名前を並べる側は原理的に閉じない。** `[].constructor.constructor('process.exit(0)')()` は `Function` も `eval` も `globalThis` も `process` も綴らずに同じことをする（`.constructor` は不透明なホップとして数えるようにしたが、これも 1 つの綴りでしかない）。**そこで綴りを見ない層に置き換える**: 各ゲートを、`npm` をシムに差し替えた子プロセスで実際に走らせる **negative control の行列**。他はすべて成功させ（テストには満点のレポート、ベンチには合格の JSON を書かせる）、**流すと書いてある検証を 1 つだけ失敗させて**、ゲートが非 0 で終わることを 1 つずつ見る。あわせて **何も壊さなければ 0 で終わる**ことも見る（positive control。これが検査自身の射程を固定する — 射程が縮めば「壊していないのに落ちる」か「壊したのに落ちない」のどちらかで必ず赤くなる）。**検査対象を「実際に呼ばれた `npm`」から導いてはいけない** — 途中で黙って終わる変異は呼び出しの一覧ごと縮むので、検査も一緒に縮んで素通りする（実測で、判定の直後に反射的な終了を置く変異も、`audit` の判定を `if (false && …)` にする変異も全件緑で通った）。**ソース（流すと書いてある `npm` の引数）と `STEP0_STEPS` から別に導き、実際に流したものと突き合わせる**。これで、綴りを追っていた頃の 8 巡ぶんの変異（`globalThis` 経由・間接 exit・`eval`/`Function`・`.constructor`・反射的アクセス）と、静的には見えない形（ベンチの結果を偽装するヘルパー・ベンチの失敗だけ握り潰す判定）が**同じ 1 つの理由**で落ちる。同じ考え方は共有モジュール（`importsWithoutExiting`）とベンチ（`runBenchInCleanChild`）が既に使っている。**シムの PATH は先頭に足すのではなく置き換える** — 足すだけだと、シムを起動できない環境で探索が本物の `npm` へ落ち、入れ子の検証が走って上限まで止まる。**行列は両向きに突き合わせる** — 「書いてあるものを流しているか」だけでなく「流しているものが導出に入っているか」も見る（導出が黙って縮むと、実際に流している検証が negative control の対象から外れて「壊しても落ちない」窓が開く）。**検証コマンドの成否だけでは見えない緩め方もある**ので、レポートの中身を 1 件欠かす negative control を別に持つ（料金表の一部しか見ない変異はどの `npm` も失敗させない）。**欠かす位置は末尾 1 か所ではなく全添字を 1 本ずつ**回す — 末尾だけだと「末尾を含んだまま縮める」形（`slice(1)`・偶数添字だけ）が実測で全件緑を通った。料金表は小さいので全添字でも数秒で、これで「部分集合にする」族がまとめて閉じる。**この probe が実際に本物の fail-open を掘り当てた**: 基準のテスト名の照合が素の `includes` だったため、`料金: openai gpt-5` のテストが 1 件も無くても `gpt-5-mini` の名前が代わりに当たり、ゲートは緑のまま「誤差 0」を一度も確かめずに通っていた（`gpt-4.1` と `gpt-4.1-mini` も同じ）。いまは needle の直後が識別子を続けられない文字であることまで求める。**残る境界**: 許可リストが見るのは直接の import 先だけで推移的な依存は追わない。**ゲートのステップを丸ごと削除する形は検出網では捉えられない**（「流すと書いてあるもの」から導く以上、書くのをやめれば要求も消える）ので、`npm audit` と本番ビルド・lint・format:check・typecheck は CI に別ステップとしても置いて二重化してある（検出網を増やすより安い）。**二重化の一覧は手書きせず、行列と同じ手掛かり（`STEP0_STEPS` ＋ ゲートのソースの npm 引数）から導き、二重化しないものだけを理由付きの表に登録する** — 手書きだと新しい検証を足した人が「二重化するか」を一度も問われない。**突き合わせは `&&` で割った素のコマンドとの完全一致**にする（部分一致だと `npm run lint || true`＝削除と等価も、`npm audit --audit-level=critical`＝受け入れ基準そのものの緩和も、実測で全件緑のまま通った）。**同じ理由で、この行列そのものを消す差分も検出網には映らない**（テストを消したことを別のテストで落とす一般解は無く、痕跡はテスト件数の減少だけ）— これはこのリポジトリに限らずテスト全般の境界で、レビューで見る。ベンチ本体の計測式（何を測って `slowestMs` に入れたか）には静的・動的どちらの検出網も無く、レビューで見る。`typeof globalThis` のような正当な特徴検出も現在は落ちる（そう書いているファイルは無い）。**import 時に `process.env.DATABASE_URL` を書き換える形は静的には閉じきれない**ので、規約とレビューで守る（理由は `scripts/lib/contract-database.mjs` の docstring）。
- `scripts/gate-stepN.mjs` — Step ごとの受け入れ基準の検査（ADR-0004）。**受け入れ基準の値はゲート本体に書かず `scripts/lib/stepN-criteria.mjs` に置く**（後の Step のゲートが同じ定義を読む。ゲート本体に数値を書けると新しい Step で静かに緩められるので、`tests/docs-gate.test.ts` が「ゲート本体は基準の数値を宣言しない」ことも見張る）。**判定そのものは `scripts/lib/gate-report.mjs` の純粋関数に置き、`tests/gate-scripts.test.ts` が挙動を固定する** — スクリプトに書き下すと、件数の下限を小さくしても判定を `if (false && …)` にしてもゲートは緑のまま通った（実測）。しきい値そのものは `tests/docs-gate.test.ts` が `docs/roadmap.md` の**その Step の行**と突き合わせる（表全体を対象にすると、別の行の「ADR 3 件以上」に当たって下限 3 が素通りする）。**判定結果から終了コードへの写像は `scripts/lib/run-npm-steps.mjs` の `exitIfFailures` に集約する** — スクリプト本体に `process.exit(1)` を書くと、その 1 行を消すだけで「失敗の理由を表示したうえで `gate:step1 緑` と出て exit 0」になった（実測）。`runSteps` ともども子プロセス経由で挙動を固定している。
- `prisma/` — スキーマ・マイグレーションと seed。**seed は「値（`seed-data.ts`）」「投入手順（`seed-apply.ts`）」「入口（`seed.ts`）」に分ける** — 入口は読み込むだけで DB へ繋ぐのでテストから実行できず、値だけを検査しても「定義は §15 を満たすのに実際には admin しか作られない」形が全件緑で成立した（実測）。投入手順は `tests/data/seed.contract.prisma.test.ts` が実 DB で「定義どおりに入るか」と冪等性を固定する。
- `tests/` — Vitest（`environment: 'node'`）。`tests/api/*.test.ts` は memory アダプタで Route Handler を直接呼ぶ API テスト（`tests/api/helpers.ts` の `setupSeed()` が 2 テナント × 3 役割のユーザーとトークンを seed し、`call()` がハンドラを呼ぶ）。DB を触る挙動は契約テスト（`tests/data/*.contract.prisma.test.ts`、専用 DB、`RUN_PRISMA_CONTRACT=1` のときだけ。`beforeEach` で `TRUNCATE "Tenant" CASCADE`）へ寄せる。設定の写しを見張る検出網: `docker-seed-files`（Dockerfile の seed 用 COPY 列挙 = seed の import グラフ）/ `node-runtime-alignment`（`.nvmrc` / Dockerfile / `engines.node` / CI 配線 / `@types/node` の major 一致）/ `dependabot-eslint-guard`（eslint major 保留の存在と期限切れ）/ `dependabot-typescript-guard`（typescript major 保留の存在と期限切れ）/ `dependabot-runtime-hold-guard`（`@types/node` と docker の `node` の保留の存在）。**最後の 1 つを前 2 つと同じファイルに置かない** — 前 2 つは「上流が対応したら ignore とテストごと削除する」運用なので、同居させると解除の日に恒久の保留のガードまで巻き添えで消える（実測: eslint 側を運用どおり削除したうえで 2 件の ignore を外すと全件緑で、痕跡はテスト件数の減少だけだった）。**`dependabot.yml` の読み方は `tests/lib/dependabot-config.ts` に集約する**（保留を見張る検査は依存ごとに増えるので、読み方を書き写すと設定の書き方が変わったときに片方だけが直り、もう片方の検出網が古い読み方のまま静かに残る）。

### マルチテナントと RBAC（設計の不変条件）

- 全テーブルが `tenantId` を持つ行スコープ方式（ADR-0002）。**Server Action / Route Handler は冒頭で認証情報から `tenantId` を取り出し、`where` に必ず差し込む**（足し忘れはクロステナント漏洩）。他テナントの資源は 404 で隠す（403 だと存在が漏れる）。
- 書き込み系の API は RBAC 違反を 403 で返し、OpenAPI 定義にも `403` を宣言する。認証は Bearer 2 種（ADR-0005）: ユーザートークン（`UserToken`。ハッシュ保存・既定 90 日・失効/期限切れ/ユーザー無効化はすべて同じ 401）と、`GET/POST /tenants` 専用のプラットフォーム管理者トークン（環境変数 `PLATFORM_ADMIN_TOKEN`、32 文字以上。未設定・短すぎは「存在しない」扱い = fail-closed。テナント内の資源には閲覧も含め 403）。`admin` ロール限定の操作（ユーザー招待・役割変更・無効化・トークン発行/失効）は `requireAdminRole` で役割そのものを比べる（`role === 'admin'` を許す唯一の用途）。**資格情報の系統は混ぜない**: `authenticate()` は API キーを受け付けず（有効なキーでも 401）、`authenticateApiKey()` はユーザートークンを受け付けない。**両向きとも検査する** — 逆向きだけが 6 件で守られていて、`authenticate()` に 1 行足して API キーを受理させる変異は実測で全件緑のまま通り、ユーザー向け API 上に「そのキーは有効か・紐づくエージェントは停止中か」を 403 で答えるオラクルが生えた（だから 401 であることまで固定する）。自分自身の無効化と最後の有効な `admin` の降格・無効化は 409。ユーザーは削除せず無効化する（`disabledAt`）。
- 金額はマイクロ USD の整数（`BigInt`、1 USD = 1,000,000）で持ち、JSON では文字列で運ぶ（浮動小数誤差を避ける）。
- API キーは SHA-256 ハッシュ（`keyHash`）と先頭数文字（`prefix`）だけを保存し、平文は発行応答でしか返さない。
- 監査ログ（`AuditLog`）は追記専用。Step4 で改ざん検知（ハッシュ連鎖）を足す。削除の規則（履歴は `Restrict`、設定は `Cascade`、`actorId` は `Restrict`、子テーブルは複合 FK `(tenantId, 親id)`）は `docs/spec.md` §3「削除の規則」が正本。
- エージェントの状態は `active` / `stopped`（手動）/ `suspended`（ガードレールによる自動停止。復帰は `admin` の `resume`）。

### 見せ方（§15 の具体化）

- スタック形態は「DB/常駐サーバーが必要な Web」: README 冒頭のデモブロックは**デモ動画（GIF/mp4）必須**、公開 URL は任意（Step7 で Vercel/Supabase 向け設定を用意してから）。
- 撮影対象スクリーンショット（Step5 で `docs/screenshots/` に置く。シードデータのみ使用・実在のメールアドレス厳禁）: `dashboard.png`（コスト・品質・稼働率）/ `agents-list.png`（エージェント一覧）/ `agent-detail.png`（エージェント詳細・停止/復帰）/ `incidents.png`（インシデント一覧）/ `login.png`。
- デモ GIF: 「登録 → 実行 → 超過 → 停止 → 復帰」フロー 1 本（10MB 以下）。撮影は Playwright の自動撮影スクリプトを用意する。

---

## 4. 実装フロー（プランモード必須）

コード変更を伴う作業に着手する前に、**必ず Claude Code のプランモード（Plan Mode）で計画を作成し、ユーザーの承認を得てから実装に移る**こと。

- 対象: 機能追加・改修・リファクタ・バグ修正など、ソースコード／スキーマ／設定ファイルを変更するすべての作業。
- 計画には以下を含める:
  1. **Context**: 何を、なぜ変更するのか。正本（要件定義書・計画書）のどの項目に対応するか。
  2. **変更対象ファイル**: 修正・追加するファイルの絶対パス（既存ファイルは行番号や関数名まで具体化）。
  3. **再利用する既存実装**: 既にある関数・モジュール・Port を優先して再利用する。新規作成する場合はその理由を明記。
  4. **検証方法**: lint / typecheck / test（必要に応じて E2E）と、画面確認の手順。
- **例外**: タイポ修正・コメントのみの変更・1 行以下の自明な修正は計画作成を省略してよい。それ以外は必ず `ExitPlanMode` でユーザー承認を得る。
- 計画と異なる実装が必要になったら、いったん手を止めてプランを更新（または `AskUserQuestion` で確認）してから続行する。

## 5. コメント規約（最優先）

- **1 行ごとに初心者でも意味がわかるコメントを書く。** コード 1 行ごとに、プログラミング初心者でも処理内容が理解できる日本語コメントを付ける。変数宣言・条件分岐・関数呼び出し・ループ・`return` など、すべての実行行に対して「何をしているか」を説明するコメントを必ず添える（型定義の単純な再エクスポートなど明らかに自明な行は除く）。
- コメントは行の直前または行末に記述し、専門用語を使うときは平易な言い換えを併記する。
  - 例: `var x = users.Where(u => u.IsActive); // アクティブなユーザーだけを抜き出す`
- このルールは本方針固有であり、汎用的な「コメントは最小限に」というガイダンスよりも**優先**する。
- 言語別コメント記法: C# / JS / TS は `//`、Razor (`.cshtml`) は `@* *@`、JSON など非対応形式は対象外。

## 6. コーディング規約

- **既存コードのスタイルに合わせる。** インデント・命名・ファイル構成は周囲の慣習を踏襲する。
- **自己説明的な構成にする。** モジュールは単一責務に分割し、ファイル名・関数名から役割が推測できるようにする。公開関数には docstring / コメントで意図を残す。
- **設計判断を残す。** 非自明な実装やトレードオフには「なぜそうしたか」をコメントで残す。
- **定数・ラベルは一元管理する。** 配色・フォント・余白・UI 文言・enum ラベルなどは単一の参照元（例: `theme.py`, `constants.ts`, `EnumLabels.cs`, CSS の `:root` 変数）に集約し、各所に直書きしない。新しい値を追加したら参照元をすべて更新する。
- **マジックナンバー・マジック文字列を避ける。** 意味のある値（しきい値・キー名・パスなど）は名前付き定数にし、上記の一元管理に従って単一の参照元に置く。意図が読み取れない裸の数値・文字列をコードに散らさない。
- **重複を避ける（DRY）。** 同じロジックを書き写す前に既存の関数・モジュール・Port を探して再利用する（§4 のプラン段階で確認）。ただし将来を見越した過度な抽象化は避け、実際に 2〜3 箇所目で重複したら共通化する。
- **エラーを握り潰さない。** 例外は黙って捨てず、文脈を付けて再送出するかログに残す。空の `catch` / 裸の `except:` を作らない。回復不能な失敗は安全側に倒し（§9 の fail-closed）、ユーザーには内部詳細を含まない安全なメッセージを返す。
- **デッドコードを残さない。** 使われない import・変数・関数や、コメントアウトしただけの旧コードは削除する（履歴は Git に残る）。
- **変更は最小スコープに保つ。** 1 つの変更は単一の目的に絞り、無関係なリファクタや整形を同じ差分に混ぜない（§12 の「1 コミット = 1 論理変更」と整合）。レビューしやすい粒度を保つ。
- 言語別の補足:
  - **TypeScript**: `strict: true` を維持。`any` は禁止（不明なら `unknown`）。Props は `interface` で定義。パスエイリアス `@/*` → `src/*`。Server Component をデフォルトにし、必要時のみ `'use client'`。
  - **Python**: `from __future__ import annotations` を先頭に。公開関数に docstring。入力検証は「範囲外→クランプ、非数値→デフォルト」パターン。定数は `UPPER_SNAKE_CASE`。
  - **Bash**: 先頭で `set -euo pipefail`。ログは stderr。インデント 4 スペース。

## 7. アクセシビリティ（a11y）

- **対象は Web フロントエンド（HTML/CSS/JS を伴う UI）。** CLI・ライブラリ・バッチや、HTML を持たないネイティブ GUI（tkinter 等）には適用しない（共通規約の中で数少ない、適用範囲が限定される項目）。ネイティブ GUI の a11y は各リポジトリの固有ルールで扱う。
- **セマンティック HTML を使う。** 見出しは階層（`h1`→`h2`→…）を飛ばさず、操作要素は `<button>` / `<a>` を使う。`div` / `span` に `onClick` を乗せて疑似ボタン化しない。
- **キーボードだけで全機能を操作できるようにする。** フォーカス可能要素は可視のフォーカスリングを残す（`outline` を消す場合は代替の見た目を用意）。モーダルはフォーカストラップ＋`Esc` で閉じ、`tabindex` は `0` / `-1` のみ使う（正の値は使わない）。SPA でページ遷移したらフォーカスを新ページの先頭（`main` 等）へ移し、本文へ飛ぶスキップリンクも用意する。
- **スクリーンリーダーに情報を伝える。** 画像に `alt`（装飾画像は `alt=""`）、アイコンだけのボタンに `aria-label`、フォーム入力に対応する `<label>`（または `aria-labelledby`）を付ける。`aria-live` は簡潔な状態通知・エラーなど「即時に読み上げてほしい変化」に限って使う（検索結果・タイマー・カルーセル・ストリーミング等、頻繁に変わる領域全体に付けると読み上げ過多でかえって使いづらくなる）。
- **色だけに意味を持たせない。** エラー・成功などの状態はテキストやアイコンも併用する。コントラスト比は WCAG AA を満たす（通常文 4.5:1 / 大きな文字 3:1。加えて UI 部品の境界・状態・フォーカスリングや意味のある図形などの非テキストは 3:1＝SC 1.4.11）。配色は §6 の一元管理（CSS の `:root` 変数・`theme`）側でコントラストも担保する。
- **動きを抑えられるようにする。** `prefers-reduced-motion` を尊重し、過度なアニメーションは無効化できるようにする。
- **言語属性と外部リンクを正しく設定する。** ルート要素の `lang` は実際の文書の言語（§1 で宣言した UI 言語）に一致させる。多くは日本語なので `lang="ja"` だが、UI が他言語のリポジトリやローカライズページでは、その言語を正しく指定する（発音・言語処理が支援技術の挙動を左右するため）。別タブで開く外部リンクには `rel="noopener noreferrer"` を付ける。
- **検証する。** Lighthouse / axe などで a11y を確認し、可能なら CI（§14）に組み込む。キーボードのみでの操作確認を手動チェックに含める。

## 8. パフォーマンス・リソース

- **N+1 クエリを避ける。** ORM では関連を eager-load（EF Core の `.Include`、Prisma の `include` / `select`）でまとめて取得する（§E の `.Include(x => x.Incident)` と整合）。ループの中で 1 件ずつクエリを投げない。
- **よく絞り込む列にインデックスを張る。** `where` / `order by` / `join` で頻繁に使う列（ユーザー ID・日付・ステータス等）には DB インデックスを作成し、全件走査（sequential scan）を避ける。複合条件では複合インデックスの列順も意識する。
- **一覧取得は必ず上限・ページネーションを持たせる。** 件数無制限の取得をしない（§9 の DoS・リソース枯渇防止と整合）。既定件数・最大件数は定数で一元管理する（§6）。
- **計測してから最適化する。** 推測で最適化せず、プロファイラ／メトリクスで遅い箇所を特定してから手を入れる。早すぎる最適化で可読性を犠牲にしない。
- **重い処理で UI／イベントループを止めない。** 大量データの計算・変換・パースは分割や非同期化（Web Worker・ストリーム処理・バックグラウンドジョブ）で行い、メインスレッドやリクエスト処理をブロックしない。
- **フロントの配信を最適化する。** Web ではバンドルを分割（dynamic import / code splitting）し、画像は適切なフォーマット・サイズで最適化する。フォールド下や重要でない画像は `loading="lazy"` で遅延読み込みし、ファーストビューの LCP 候補（ヒーロー画像等）は遅延させず優先的に読み込む（Next.js は `next/image`。LCP 画像の優先読み込みはバージョンに応じて指定する: 16+ は `preload`、〜15 は `priority`）。重い依存は遅延読み込みする。
- **Core Web Vitals を意識する。** LCP / CLS / INP を悪化させない。画像・広告枠などにはサイズを指定してレイアウトシフトを防ぎ、Web フォントには `font-display: swap`（または `fallback`、装飾用途は `optional`）を設定して FOIT（文字が一定時間不可視になる現象）で LCP を悪化させない。
- **キャッシュを活用する。** 同じ計算・取得を繰り返さない（メモ化やフレームワークのキャッシュ機構 — Next.js なら既定は `unstable_cache`、16+ で `cacheComponents` を有効にしている場合のみ `use cache`、§D と整合 — を使う）。キャッシュは無効化条件を明確にし、古いデータを返さないようにする。
- **リソースを確実に解放する。** 接続・ファイル・タイマー・購読は使い終わったら閉じる（§D の SSE 購読のように、購読解除を必ず実装する）。

## 9. セキュリティ（必達）

- **入力は信用しない。** 外部入力（ユーザー入力・設定ファイル・JSON・環境変数）は必ず検証する。Web ではスキーマ検証（例: Zod の `safeParse`）を通してから永続化・API へ渡す。壊れたデータでクラッシュさせず、不正値はフォールバックする。
- **正規表現で algorithmic DoS（ReDoS）を起こさない。** 信頼できない入力に使う正規表現はネストした量指定子（`(a+)+` など）を避け、入力長に上限を設ける。複雑なパターンは線形時間のマッチャや専用の検証ライブラリに寄せ、未検証の正規表現を外部入力に直接当てない。
- **秘密情報をコミットしない。** 認証情報・トークン・API キー・個人情報をコード・ログ・コミットに含めない。`.env` / `.env.local` はコミットせず、`.env.example` にキー名だけ記載する。
- **API キーをフロントエンドに露出させない。** 外部 API はサーバー側（API ルート / Server Action）経由で呼ぶ。モデル名やエンドポイントは定数・環境変数で管理し、ハードコードしない。
- **認可はサーバー側で強制する。** UI を隠すだけに頼らず、Server Action / コントローラの冒頭で認証・ロールチェックを行う。マルチテナントではクエリに必ずテナント条件（`where.tenantId = session.user.tenantId`）を差し込み、クロステナント漏洩を防ぐ。
- **外部 Webhook は署名を検証する。** 受信 Webhook は共有シークレットで HMAC 署名（例: `X-Hub-Signature-256`）を検証し、一致しないリクエストは拒否する。アプリ層の認証だけに頼らず、なりすまし POST で状態を変えられないようにする。検証は定数時間比較で行う。
- **危険な実行・安全でない解析を避ける。** `eval` / `exec` / `pickle` / `shell=True` を使わない。外部コマンドは引数配列で実行し、ユーザー入力を文字列連結でシェルに渡さない。信頼できない XML は外部実体（XXE）・DTD を無効化したパーサで読み（.NET は `DtdProcessing = Prohibit`、Python は `defusedxml`）、YAML は `safe_load`、JSON は eval せず標準パーサで解析する。
- **失敗しても安全側に倒す（fail-safe / fail-closed）。** 例外時はクラッシュや権限昇格ではなく機能を縮退して継続する。権限・ネットワーク・パスの判定は「不明なら拒否」をデフォルトにする。
- **最小権限・最小公開。** 読み書きするファイルは想定パス配下に限定し、外部由来の値をそのままパスに連結しない（パストラバーサル防止）。
- **サーバー側の外向きリクエストを検証する（SSRF 対策）。** ユーザー由来の URL をそのまま `fetch` / HTTP クライアントに渡さない。スキーム・ホストを許可リストで制限し、プライベート IP（`127.0.0.0/8` / `10.0.0.0/8` / `169.254.0.0/16` 等）やクラウドメタデータ（`169.254.169.254`）への到達を遮断する。リダイレクト追跡先も同様に検証する。
- **リダイレクト先を検証する（オープンリダイレクト対策）。** `returnUrl` / `next` など外部由来の遷移先は、自サイト内パス（または許可リスト）に照合してからリダイレクトする。任意の絶対 URL へ飛ばさない（ログイン後フィッシング防止）。
- **出力もエスケープする（インジェクション対策）。** SQL は ORM／パラメータ化クエリで組み立て、ユーザー値を文字列連結で SQL に混ぜない。HTML はフレームワークの自動エスケープに任せ、`dangerouslySetInnerHTML` / `v-html` / `innerHTML` などの生 HTML 挿入は原則避ける（やむを得ない場合はサニタイズしてから）。OS コマンド・パス・LDAP なども同様に値を直接連結しない。
- **状態変更リクエストを保護する。** フォーム送信や書き込み系 API には CSRF トークン（またはダブルサブミットクッキー）を必須とする。`SameSite` クッキーはそれを置き換えるものではなく、多層防御として併用する（OWASP 準拠。登録ドメインを他サービスと共有する場合、サブドメイン経由や `Lax` のトップレベル遷移では `SameSite` だけでは防げない）。副作用のある操作を GET で行わない。
- **機密情報・PII・スタックトレースをログやエラー応答に漏らさない。** 外部にはサニタイズした安全なメッセージだけを返し、詳細はサーバ内ログに限定する。ログに残す前にトークン・個人情報はマスク／伏字化する。
- **暗号・認証情報は自前実装しない。** パスワードは平文・可逆形式で保存せず bcrypt / argon2 等でハッシュ化する。暗号化は標準ライブラリを使い、自前の暗号方式を発明しない。署名・擬似匿名化に使うソルトや鍵は環境変数から取得し、未設定なら起動を失敗させる（fail-closed）。
- **依存（サプライチェーン）を管理する。** ロックファイルをコミットし、新規依存は最小限に絞って出所・メンテ状況を確認する。`npm audit` / Dependabot 等で既知脆弱性を定期的に確認し、放置しない。
- **公開エンドポイントを保護する。** レート制限と、リクエストサイズ・タイムアウト・ページネーション上限を設けて DoS とリソース枯渇を防ぐ。

## 10. 移植性・プラットフォーム差異ゼロ設計

- **ロジックと UI を分離する。** ビジネスロジックは表示層に依存しない純粋関数として保ち、Web / デスクトップ / モバイルで共有できる状態を維持する。
- **プラットフォーム差を 1 か所に閉じ込める。** OS / 実行環境固有の処理は分岐（例: `platform.system()`）で局所化し、必ずフォールバックを用意する。
- **移植可能な書き方をする。** 特定 OS でしか動かない記述（例: `strftime` の `%-d`）を持ち込まない。同じ操作はどの環境でも同じ結果になるよう、判定ロジックは共有層に置きテストで担保する。
- **契約（contract）で同一性を保証する。** 言語・プラットフォーム非依存の入力→期待出力ケース（例: JSON の契約ファイル）を真実の源とし、各実装はそれに従う。

## 11. テスト

- **テストは必ず通過させること。** 変更の前後で、そのリポジトリの §2 と CI 設定（`.github/workflows/`）に記載された実際の検証コマンド（lint / 型チェック / テスト等、存在するものすべて）を通す。コマンド名や有無はスタックごとに異なるため、§2 と CI 設定を正本とし、ここに書かれた例（`lint && typecheck && test` 等）をそのまま当てはめない。
- テストファイルはそのスタックの慣習に従った場所・命名で配置する（例: Python/JS は `tests/` に `test_<module>.py` / `*.test.ts`、Maven は `src/test/java` に `<Class>Test.java`、.NET は専用テストプロジェクトに `<Class>Tests.cs`）。
- **純粋ロジックはユニットテスト、DB / 外部依存は E2E or 契約テストに寄せる。** ユニットテストに DB アクセスを持ち込まない。外部 API はモックして実際には呼ばない。
- 境界値（0・最大・空文字列・非数値など）を重視する。OS 依存処理はモック（`@patch` 等）し、特定 OS でしか通らないテストを作らない。
- DB を破壊的に扱う契約テストは、専用 DB を明示フラグで起動したときだけ走らせ、開発 DB を指さない。共有 DB を `TRUNCATE` するテストは直列実行する。

## 12. Git 規約

- コミットメッセージ形式: `type(scope): 日本語の説明`
  - type: `feat` / `fix` / `refactor` / `test` / `docs` / `chore`
  - scope: 変更領域（例: `chat`, `api`, `ui`, `tickets`, `reminder`）
  - 例: `feat(chat): ストリーミング応答の実装`
- **1 コミット = 1 論理変更。** スキーマ変更とマイグレーションは同一コミットに含める。
- 開発は機能ブランチで行い、`main`（デフォルトブランチ）への直 push は避ける。

## 13. PR・レビュー運用

- **PR は draft ではなく open（ready）で作成する。** harness のデフォルトが draft の場合は、作成直後に ready 化してから次の手順に進む。
- **コードレビューは `/code-review ultra` と `/security-review ultra` で行う（Codex 自動レビューは廃止）。** PR を ready 化して open にした直後、および PR ブランチへ push するたび（初回 PR 作成時を含む）に、この 2 つのスキルを実行して差分をレビューする。`@codex review` コメントの投稿は行わない（`chatgpt-codex-connector` 連携には依存しない）。
  - `/code-review ultra` — 差分の正確性（バグ）と、再利用・簡素化・効率・粒度（altitude）の観点でレビューする。
  - `/security-review ultra` — ブランチの保留中変更に対してセキュリティレビューを行う。
  - 指摘は対応可否を判断して反映し、対応・見送りの理由をチャットで報告する。質問返信やレビュー不要な状況報告では実行しない。
- **CI の成否（グリーン）はチャット上で報告する。** GitHub MCP（check-runs / status）で取得して報告する。
- **ユーザーへの結果報告・要約は必ず日本語で出力する。** CI の成否・レビュー結果・作業サマリなど、要約した結果は常に日本語で記述する（各リポジトリの UI／コード言語に関わらず、チャットでの報告は日本語に統一する）。

## 14. CI

- GitHub Actions（`.github/workflows/`）でそのリポジトリに必要な検証を実行する。実行するジョブはスタックに応じて異なる（例: Web/TS なら lint → typecheck → test → E2E、Maven なら `mvn -B verify`、.NET なら `dotnet build` ＋ `dotnet test`、シェル/Docker なら shellcheck / hadolint / `docker compose config` ＋ e2e）。**PR を出す前に、§2 と CI 設定に記載のローカル検証コマンド（そのリポジトリに実在するものすべて）を通す。** 存在しないコマンドを当てはめない。
- DB / ブラウザ依存のジョブはサービスコンテナ（PostgreSQL 等）や chromium を使う。依存があるスタックでは、ローカルでも `docker compose up` などで依存を起動してから実行する。

## 15. 見せ方（ショーケース）

> **成果物は「動くコード」だけでなく「伝わる見せ方」までを完成の定義に含める。** README を開いて 5 秒で「何のアプリで、どんな画面か」が伝わらない状態を不合格とする。

- **README 冒頭に「デモ」ブロックを必須で置く（UI を持つ全リポジトリ）。** 概要の直後に次の 3 点を配置する: (1) 公開デモ URL（バッジまたはリンク）、(2) 主要画面のスクリーンショット 3〜5 枚、(3) 代表的な操作フロー 1 本のデモ GIF/動画。CLI・バッチはスクショの代わりに端末操作の録画（asciinema / GIF）を置く。
- **公開デモ URL は段階必須とする。** 無料枠で維持できる形態は URL を必須、維持コストが発生する形態は動画で代替可とする（規約の形骸化を防ぐため強制度を分ける）。

  | スタック形態 | ルール | 手段の例 |
  |---|---|---|
  | 静的サイト | URL **必須** | GitHub Pages |
  | serverless で完結する Web | URL **必須** | Vercel 等の無料枠。公開前にレート制限・利用上限を設定（§9 と整合） |
  | DB/常駐サーバーが必要な Web | デモ動画 **必須**、URL は任意（推奨） | Neon・Render 等の無料枠＋シードデータ＋定期リセットを整備できる場合に公開 |
  | CLI / バッチ / サンドボックス | 録画で代替（URL 適用外） | asciinema / 端末操作 GIF |
  | ネイティブ GUI（tkinter 等） | スクショ＋GIF **必須**（URL 適用外） | OS のスクリーンショット / 画面録画 |

- **画像は保存場所・命名・品質を一元化する。** `docs/screenshots/` 配下に `<画面名>-<状態>.png`（例: `incident-list-default.png`）で置く。幅 1280px 目安、GIF は 10MB 以下に最適化し（§8 の配信最適化と整合）、すべての画像に日本語の `alt` を付ける（§7 と整合）。
- **スクショにはシード/ダミーデータのみ使う。** 実データ・PII・秘密情報・実在のメールアドレスを写さない（§9 と整合）。デモ用シードデータの投入コマンドは §2 に記載する。
- **UI 変更 PR では該当スクショを同一 PR で更新する。** コードとドキュメントの乖離を許さない原則（§3）をスクショにも適用する。変更した画面が写っている分だけ更新すればよく、全量の再撮影は不要。
- **撮影は自動化を推奨する。** Web 系リポジトリはシードデータ入りの画面を Playwright 等で自動撮影するスクリプト（例: `scripts/capture-screenshots.ts`）を用意し、実行コマンドを §2 に記載する。非 Web GUI は手動撮影でよい。
- **デモ環境は本番と分離し fail-safe にする。** デモアカウントは閲覧専用の最小権限ロール、環境変数・シークレットは本番と共有しない、書き込みは無効化または定期リセットする（§9 と整合）。
- **撮影対象画面・デプロイ先はリポジトリごとに具体化する。** 各リポジトリの `CLAUDE.md`（§1〜§3）に「どの画面を何枚撮るか」「どこへデプロイするか」を明記し、この章はその共通基準として使う。

---

## 付録: リポジトリ別のルール（Appendix）

各リポジトリの `CLAUDE.md` から、**§4〜§15 の共通規約と重複しない固有ルールだけ**を抜き出したカタログ。
新規リポジトリが似た技術スタックの場合、該当ブロックを §1〜§3 の具体化や追補として流用できる。
（出典の `CLAUDE.md` には、ここに載らないプロジェクト固有のアーキテクチャ詳細も含まれる。詳細は各リポジトリを参照。）

### A. profile-portfolio（静的 HTML/CSS/JS, GitHub Pages）

- **サイト本体にページ生成のビルドステップは無い**（`index.html` / `resume.html` をそのまま配信する）。表示確認は `open index.html` または `python -m http.server 8000`。
- 一方で検証・撮影用に npm ベースの開発ツール（html-validate / Playwright ビジュアルリグレッション / Lighthouse CI / スクショ自動撮影）を持つ。`package.json` ・ `package-lock.json` はコミットし、検証は `npm ci` の後に CI と同じコマンド（`npx html-validate` / `npm run test:e2e` / `npm run test:lighthouse`）で流す。
- ファイル構成: `index.html`（ダークテーマ）/ `resume.html`（ライトテーマ・印刷対応）/ `data/portfolio.json`（表示データ）/ `e2e/`（ビジュアルリグレッション）/ `scripts/`（スクショ・デモ GIF の自動撮影）。
- 色の変更は `:root` の CSS 変数（`--primary`, `--accent`, `--bg-dark` 等）経由。個別要素にカラーコードを直書きしない。
- レスポンシブ: ブレークポイント 968px（タブレット）・768px（モバイル）。グリッドは `auto-fit, minmax()` でメディアクエリを最小化。フォントは `clamp()` で流体タイポグラフィを適用。
- CSS は BEM 風命名（`.section-header` 等）、JS は Vanilla のみ（外部ライブラリを追加しない）。a11y の基本（セマンティック HTML・`alt`・外部リンクの `rel`・`lang`）は §7 に従う（この repo は日本語 UI なので `lang="ja"`）。
- セクション追加時は Intersection Observer の `.observe()` 対象に追加し、ナビリンク・768px 表示・`resume.html` 反映を確認する。

### B. my-task-manager（Python + tkinter, GUI）

- ビジネスロジックは GUI 非依存の純粋関数に保つ（`timeline.py` / `stats.py` / `recurrence.py` / `task.py`）。表示層を差し替えてもロジックを共有できる状態を維持。
- デザイントークン（配色・フォント・余白・カレンダー寸法）は `theme.py` に一元化。見た目の値をコードに直書きしない。
- 繰り返しタスクは「完了した時点」を起点に日/週/月/年で再スケジュール（月末日・うるう年はクランプ）。
- 言語・プラットフォーム非依存の繰り返し契約は `contract/recurrence_cases.json` を真実の源とし、契約駆動テスト（`test_recurrence_contract.py`）で検証。Web/スマホ版も同一契約に従う。
- tkinter の `StringVar` / `IntVar` はテスト用 `_DummyVar` で代替し、`AppTestCase._app()` ファクトリ（`tests/test_planner.py`）でモック済みインスタンスを生成（Tk 無しでテスト可能）。
- 入力検証は `_coerce_int()` パターン（範囲外→クランプ、非数値→デフォルト）。
- 今日のタスクは Treeview でなく `tk.Canvas` の「デイビュー」で描画し、位置・高さは分→px 換算（`HOUR_HEIGHT`）で Canvas 実サイズに依存させない。
- クロスプラットフォーム: 音/通知は macOS(`afplay`)・Windows(`winsound`)・Linux(`notify-send`+`tk.bell()`)を `platform.system()` で分岐。`cairosvg` はオプション依存で `ImportError` 時 graceful degradation。

### C. my-first-ai-app（Next.js 16 + Claude API）

- システムプロンプトは `src/lib/prompts.ts` に集約し、コンポーネントやルートハンドラに直接書かない。プロンプトは日本語で記述。
- モデル名（`claude-sonnet-4-6` 等）は環境変数または定数で管理しハードコードしない。`max_tokens` 既定 1024、長文が必要なカテゴリは `prompts.ts` で個別設定。
- `POST /api/chat` が唯一の API。Claude へのストリーミングプロキシで、`ANTHROPIC_API_KEY` はサーバ側環境変数から取得しフロントに露出させない。
- API ルートに簡易レート制限（IP ベース、1 分あたり 20 リクエスト目安）。
- API ルートのエラーは HTTP ステータスを使い分け: 400（JSON 破損・入力検証エラー・上流 Claude API の 400）/ 401（キー未設定/無効）/ 413（本文サイズ上限超過）/ 415（`Content-Type` が `application/json` でない。**レート制限より前に**検証し、第三者サイトの simple request で被害者 IP のレート枠が枯渇するのを防ぐ）/ 429（レート制限超過。`Retry-After` ヘッダ付き）/ 499（接続確立前のクライアント切断）/ 500（その他）。文言は `route.ts` の `ERROR_MESSAGES` に一元管理し、フロントはユーザーフレンドリーな日本語メッセージを表示。

### D. helpdesk-hub（Next.js 16 / Prisma / Auth.js v5）

- 正本は `docs/smb-dx-pivot-plan.md`。Lite/Pro 二層・マルチテナント化・用語簡素化等の方針に反する変更をしない。Phase 0→1→2→3→4 の順序を尊重し、後フェーズ機能を前フェーズに混ぜない。
- Prisma クライアントは `src/generated/prisma` に出力される。型/enum は必ず `@/generated/prisma` から import（`@prisma/client` ではない）。クローン後やスキーマ変更後は `npm run db:generate` を実行。
- ロールは実質 requester と agent/admin の 2 種。`isAgent(role)`（`src/lib/role.ts`）を使い、`role === 'admin'` を直接比較しない（admin 限定の意図がある場合を除く）。
- Mutation（Server Action）の定型: `auth()`＋ロール表明 → `findUniqueOrThrow` → 状態変更は `isValidTransition(from,to)` でゲート → Prisma で更新 → `recordHistory(...)` → `createNotification(...)` → `revalidatePath(...)`。
- 状態遷移テーブル `ALLOWED_TRANSITIONS`（`src/domain/ticket-status.ts`）が唯一の真実の源。バイパスせず、ブロックされたら表とテストを更新する。
- Data 層は Ports & Adapters。Port を `src/data/ports/` に定義し、本番は `adapters/prisma/`、テストは `adapters/memory/`。Prisma を直接 import するのは Adapter 内のみ。
- 未読通知数は SSE（`/api/notifications/stream`）＋ `unstable_cache` で配信。`sse-subscribers.ts` はインプロセス Map のため、水平スケール前に要注意。
- 契約テストは `*.contract.prisma.test.ts` 命名。`RUN_PRISMA_CONTRACT=1` のときだけ走り、`beforeEach` で全テーブル `TRUNCATE` するため**開発 DB を指さない**。`--no-file-parallelism` で直列実行。

### E. incident-insight（ASP.NET Core 8 MVC + EF Core 9）

- DB プロバイダ非依存。SQLite（既定）/ SQL Server / PostgreSQL を `Database:Provider` で切替。プロバイダ固有 SQL・列型をコードに持ち込まない。
- 楽観的同時実行制御: 編集 POST は `FindAsync` で再読込後、クライアントの編集前 `ConcurrencyToken` を `OriginalValue` に明示ピンして保存し、`DbUpdateConcurrencyException` を捕捉。トークンは hidden field で round-trip。
- 時刻は常に注入された `IClock`（JST）。`DateTime.Now/Today/UtcNow` を直接呼ばない。
- 監査ログは `AuditSaveChangesInterceptor` が唯一の源。`AuditLog` に直接書かない。`SaveChanges` 経由で更新し、`ExecuteUpdate`/`ExecuteDelete` を使わない（変更追跡を迂回し監査漏れになるため）。
- PHI 保護: 自由記述・個人名カラムには `[Sensitive(Mask.Redact)]` か `[Sensitive(Mask.Hash)]` を付与（`[REDACTED]` か HMAC-SHA256 擬似匿名化）。新カラム追加時も必ず annotate。本番で `Audit:HashSalt` 空は起動失敗。
- ビジネスルール `HasAtLeastOneValidMeasure`（インシデントは予防策が最低 1 件ないと登録不可）をバイパスしない。
- Enum（重症度・部署・インシデント種別）は `Incident` クラスの `static readonly` 辞書/配列が真実の源（DB ではない）。`EnumLabels.cs` に日本語ラベル＋Bootstrap カラーを集約。
- `SameDepartmentHandler` は `Incident` の eager-load（`.Include(x => x.Incident)`）が前提で fail-closed（null なら拒否）。
- 新規 POST アクション時チェック: `[Authorize]` / `[ValidateAntiForgeryToken]` / `ConcurrencyToken` ピン / 必要なら `.Include(Incident)` / `SaveChangesAsync` 使用 / `TempData["Success"|"Warning"]` / 新 PHI カラムに `[Sensitive]` / 対応テスト追加。テストは InMemory DbContext を優先（Mock より）。

### F. AI-Docker-Environment（Docker サンドボックス, bash, Linux 専用）

- 正本は `docs/requirements.md`。実装・新機能はすべて要件定義書に従い、衝突したら先に要件を改訂してから実装変更（同一 PR 内で §3/§4/§6 を更新）。
- すべて `bin/aidock` 経由で実行（`build`/`login`/`run`/`shell`/`firewall-refresh`/`logout`）。`guard_workspace()` の `/` および `$HOME` をマウント拒否するガードを削除しない。
- セキュリティ不変条件（変更禁止 or 影響必須検討）:
  - `compose.yaml`: `cap_drop: ALL`（必要 cap のみ add）/ `no-new-privileges:true` / `read_only: true`＋最小 `tmpfs` / メモリ・CPU・PID 上限 / ホストパスの追加 bind mount 原則禁止（`~/.ssh` 等）。
  - `HOST_WORKSPACE` に既定値を付けない（`${HOST_WORKSPACE:?...}`）。`bin/aidock` 非経由の直接 `docker compose run` を fail-closed にする。
  - `Dockerfile`/`entrypoint.sh`: `sudo` を含めず、root 起動 → firewall 初期化後に `gosu agent` で降格。ワークロードは `agent` で実行。
  - `init-firewall.sh`: `iptables -P OUTPUT DROP` と `ip6tables -P OUTPUT DROP`（IPv4/IPv6 両方 default-deny）を維持。許可ホスト追加は最小限・理由を PR に明記。DNS は許可 nameserver 限定。
- OAuth トークンは名前付きボリューム `claude-home` に置き、ホスト FS や Docker イメージ層に書き出さない。
- Linux 専用（iptables/ipset/cap_add 依存。macOS Docker Desktop 非対応）。スクリプトは Bash・先頭で `set -euo pipefail`、ログは stderr、インデント 4 スペース。
- このリポジトリのコミットメッセージは英語・命令形・1 行要約（既存履歴に倣う。§12 の日本語コミット規約より優先する例外）。

### G. batch-scheduler（Java 21 / Maven, バッチ実行マネージャ）

- 正本は `docs/DESIGN.md`（アーキテクチャ・セキュリティモデル・将来拡張）。実装はここに従い、衝突したら先に設計を改訂してから実装を変更する。
- バッチ定義ファイル（YAML）は **Makefile / CI パイプラインと同等の信頼入力**として扱う。一方で資源枯渇には防御する: bounded YAML parsing、出力キャプチャの上限、反復的（再帰でない）グラフアルゴリズム、state ディレクトリの安全性（runId 検証・シンボリックリンク非追従）。
- MVP 非目標（non-goals）: スケジューリング・並列実行・分散。
- テストは `src/test/java/...` の各クラス対応（`BatchConfigLoaderTest` / `BatchExecutorTest` / `DependencyGraphTest` 等）。CI は `mvn -B verify`（Java 21 / Temurin）。

### H. Expense-Management-Rest-API（Java 21 / Spring Boot, REST API）

- Java 21 / Spring Boot 3.3.5 / PostgreSQL 16 / Maven / Docker の REST API 単一プロジェクト。アプリ一式（`pom.xml` ・ `src/` ・ `Dockerfile` ・ `docker-compose.yml`）をリポジトリ直下に置く。金額は `BigDecimal` を使い浮動小数誤差を避ける。レスポンスは JSON、エラー形式は `{ "status": int, "message": string }`、入力検証は Jakarta Bean Validation。
- 課題の棚卸しは `docs/issue-analysis.md`（機能面・セキュリティ面の分析）。
- 層構成: `controller/` → `service/` → `repository/`（Spring Data JPA）→ `domain/`（JPA エンティティ）。`dto/request/` と `dto/response/` を分離し内部エンティティを API 契約から切り離す。`GlobalExceptionHandler` がカスタム例外を HTTP ステータスへマップ。
- 横断的関心事は `web/`（エラー応答の共通整形・ページング入力の無害化・リクエスト本文サイズ上限）・`security/`（IP ベースのレート制限フィルタ）・`validation/`（コードポイント単位の文字数検証・カテゴリ名の NFC 正規化）に分ける。
- CI は `.github/workflows/ci.yml` の `build-test` ジョブ 1 本で `./mvnw -B verify`（Temurin JDK 21）を実行する。`repository/` 配下のテストは Testcontainers で PostgreSQL を起動するため Docker デーモンが必要。

### I. agent-ops（Next.js 16 / Prisma 7, Agent Ops SaaS）

- 正本は `docs/spec.md`（ユースケース・ER 図・API 一覧）と `docs/roadmap.md`（8 Step のロードマップと受け入れ基準）。実装と衝突したら先に文書を改訂してから実装を変える。設計判断は `docs/adr/` に ADR として残す。
- **各 Step の受け入れ基準は `npm run gate:stepN` として自動化し、`main` でゲートが緑になってから次 Step のブランチを切る。** 基準を緩める変更は `docs/roadmap.md` と該当 ADR を同じ PR で更新する（テスト側だけを書き換えない）。Step の順序（0→1→…→7）を入れ替えず、後 Step の機能を前 Step に混ぜない。
- REST API は `openapi/openapi.yaml`（OpenAPI 3.1）が契約の正本。`npm run gen` が `src/generated/openapi.d.ts` に型を生成し、`src/lib/api-types.ts` がアプリ側の名前で再公開する。新しいエンドポイントは「定義 → `gen` → 実装 → API テスト」の順で作る。
- マルチテナントは行スコープ（全テーブルに `tenantId`、ADR-0002）。他テナントの資源は 404 で隠す（403 だと存在が漏れる）。
- RBAC は `viewer` / `operator` / `admin` × `view` / `execute` / `stop` の許可表 `src/domain/rbac.ts` が唯一の真実の源（不明なら拒否）。
- Prisma クライアントは `src/generated/prisma` に出力される。enum の正準は `src/domain/types.ts`（`as const` で定義し Prisma の実行時コードに依存しない。Prisma 側との一致はテストで固定）。`@/generated/prisma` の直接 import は ESLint が禁止し、例外は結線箇所の `src/lib/prisma.ts` / `src/lib/prisma-client.ts` と prisma アダプタ `src/data/adapters/prisma/` だけ（データ層は Ports & Adapters。契約 `src/data/ports/`、本番 `adapters/prisma/`、テスト `adapters/memory/`。ADR-0006）。結線は `createPrismaClient()` に集約。生成物（`src/generated/`）はコミットしない。
- 金額はマイクロ USD の整数（`BigInt`）で持ち、JSON では文字列で運ぶ。API キーは SHA-256 ハッシュ（`keyHash`）と先頭数文字（`prefix`）だけを保存し、平文は発行応答でしか返さない。
