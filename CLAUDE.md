# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> このファイルの **§4 以降（共通規約 ＋ 付録）は原本テンプレート `izumacha/claude-code-rules` の
> `CLAUDE.md` と同期**している。共通規約を変更するときは、**まず原本を改訂してから**各リポジトリへ
> 反映すること（このファイルで共通規約だけを勝手に書き換えない）。§1〜§3 は本リポジトリ固有の内容。
>
> **正本（Source of Truth）は `docs/spec.md`（仕様）と `docs/roadmap.md`（ロードマップ・受け入れ基準）。**
> 実装と衝突したら先に文書を改訂してから実装を変える。設計判断は `docs/adr/` に ADR として残す。
>
> **§3「レイヤ構成」は索引だけで、詳細は [`docs/implementation-notes.md`](./docs/implementation-notes.md)。**
> このファイルはセッションの入口として毎回全文が読まれるので、**層ごとの不変条件と「どの変異が
> 実測で素通りしたか」はあちらへ出してある**（切り出し前の大きさは実装ノートの冒頭に書いてある）。
> 触る層の節は書く前に開くこと。索引の行と節の 1 対 1 は `tests/docs-gate.test.ts` が見張る。

---

## 1. プロジェクト概要

Agent Ops — AI エージェントの**登録・権限・コスト・品質・停止**を一元管理する運用基盤（SaaS）。Next.js 16 + Prisma 7 + PostgreSQL 16（Docker）。UI テキスト・エラーメッセージ・テストの説明文は日本語で、編集時もそれを保持する。

開発は `docs/roadmap.md` の 8 Step（0 設計・骨組み → 1 台帳・権限 → 2 コスト計測プロキシ → 3 品質評価 → 4 ガードレール・停止 → 5 ダッシュボード → 6 マルチテナント・課金 → 7 リリース準備）で進める。**各 Step の受け入れ基準は `npm run gate:stepN` として自動化し、`main` でゲートが緑になってから次 Step のブランチを切る。** Step の順序を入れ替えず、後 Step の機能を前 Step に混ぜない。基準を緩める変更は `docs/roadmap.md` と該当 ADR を同じ PR で更新する（テスト側だけを書き換えない）。検証はすべてローカル＋CI で完結させる（人手の営業・ヒアリングは含めない）。

現在の段階: **Step7（リリース準備）実装済み**（`npm run gate:step7` 緑）＝ロードマップの全 8 Step 完了。**以降も最新のゲートは `gate:step7`** で、CI は常にこれを回す。

## 2. コマンド

```bash
npm run dev          # Next.js dev server (http://localhost:3000)
npm run build        # 本番ビルド（Docker 用 standalone 出力）
npm run typecheck    # tsc --noEmit
npm run lint         # eslint . --max-warnings=0 (ESLint 9 flat config + next/core-web-vitals)
                     # **--max-warnings=0 は外さない** — warning 止まりの規則（未使用 import 等）が
                     # ベンチ・ゲートの判定を 1 行消した変異を落とす唯一の経路になっている
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
npm run gate:step3   # Step3 の受け入れ基準を一括検査（gate:step2 の項目 + 不正出力の除外が除外理由の全種類分 pass + ベンチ 3 本）
npm run gate:step4   # Step4 の受け入れ基準を一括検査（gate:step3 の項目 + 発火が RuleKind の全種別分 pass + 改ざん検知が連鎖の壊れ方の全種類分 pass + E2E 1 本 + ベンチ 4 本）
npm run gate:step5   # Step5 の受け入れ基準を一括検査（gate:step4 の項目 + 突合テスト pass + 主要 5 画面の E2E 全 pass + Lighthouse の performance / accessibility が 5 画面すべてで ≧ 90）
npm run gate:step6   # Step6 の受け入れ基準を一括検査（gate:step5 の項目 + テナント越境が全パターン pass + Webhook の冪等性が pass + ロジック層のカバレッジ 4 指標すべて ≧ 80%）
npm run gate:step7   # Step7 の受け入れ基準を一括検査（gate:step6 の項目 + 既知バグ 0 + ベンチ 6 本。**最後の Step**）
npm run test:coverage # ロジック層のカバレッジを測る（判定はせず JSON を出すだけ。合否は gate:step6 が決める）
npm run test:e2e     # 主要 5 画面の E2E（Playwright・chromium のみ。先に npm run build。専用 DB が必須）
npm run lighthouse   # 5 画面の Lighthouse を 3 回ずつ測って中央値を出す（同上。判定はせず JSON を出すだけ）
npm run capture:screenshots # README 用のスクショ 5 枚とデモ動画を撮り直す（同上）
npm run bench:usage  # ベンチ: 1 万件投入で日次集計 ≦ 1 秒（専用 DB が必須。全テーブルを TRUNCATE する）
npm run bench:proxy  # ベンチ: プロキシ経由の追加遅延 ≦ 50ms（先に npm run build。専用 DB が必須）
npm run bench:evaluation # ベンチ: 固定評価セット 100 件を 2 回採点して再現率 ≧ 90%（専用 DB が必須）
npm run bench:guardrail  # ベンチ: 発火から停止まで ≦ 3 秒（専用 DB が必須。全テーブルを TRUNCATE する）
npm run bench:demo-ready # ベンチ: 本番ビルドの起動からデモの筋が通るまで ≦ 5 分（先に npm run build。専用 DB が必須）
npm run bench:concurrency # ベンチ: 同時 100 リクエストでエラー率 < 1%（同上）
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

**ベンチ 6 本（`bench:usage` / `bench:proxy` / `bench:evaluation` / `bench:guardrail` / `bench:demo-ready` / `bench:concurrency`）と E2E・Lighthouse・撮影、そして `gate:step2` 〜 `gate:step7` は DB を使う。** `DATABASE_URL` は契約テストと同じ**専用 DB（名前が `_contract` で終わる）**を指すこと — ベンチは全テーブルを `TRUNCATE` するので、開発 DB を指していれば 1 件も書かずに落ちる（判定は `scripts/lib/contract-database.mjs` の 1 か所）。ベンチが叩く上流はローカルに立てたスタブなので、**実際の Anthropic / OpenAI は呼ばず課金も発生しない**（画面は上流を呼ばないので、E2E・Lighthouse・撮影も同じく呼ばない）。

**E2E・Lighthouse・スクショの撮影はブラウザ（chromium）を使い、測る相手は本番ビルド**（`.next/standalone/server.js`）。先に `npm run build` が要る。chromium の実行ファイルは `PLAYWRIGHT_CHROMIUM_PATH` で差し替えられる（判定は `e2e/lib/chromium.ts` の 1 か所で、3 つが共有する）。**`.next/static` と `public` は standalone 出力に含まれないので、起動の前に `e2e/lib/app.ts` の `placeStaticAssets()` が置く**（Dockerfile が同じことをしている）。置き忘れると CSS と JS が 404 になり、**見た目は崩れるのに E2E は通り、Lighthouse だけが素の HTML を測って 85〜90 点で揺れる**（実測。原因が「遅い」ことに見えるので、しきい値を疑って基準を緩める向きへ誘導される）。

CI（`.github/workflows/ci.yml`）は `gate` ジョブ（ジョブ名＝ステータスチェック名は Step が進んでも変えず、実装済みの最新 Step のゲートを回す。どの Step かはステップ名で示す。Step2 からはベンチのため PostgreSQL サービスコンテナを持つ）、PostgreSQL サービスコンテナで `db:deploy` → `db:seed`（2 回流して冪等性確認）→ 専用 DB での契約テスト → `build` を行う `migrate-and-build` ジョブ、**`docker compose up` から 5 分以内にデモの筋が通ることを確かめる** `docker-smoke` ジョブ（Step7 の受け入れ基準①そのもの。`scripts/demo-probe.mjs`）の 3 本。**どのジョブも `name:` を変えない** — リポジトリの必須ステータスチェックはジョブ名で登録されているので、改名すると「必須チェックが存在しない」状態になり **CI が全部緑でも PR がマージできなくなる**（実測: `docker-smoke` を内容に合わせて改名したら `405 Repository rule violations` で止まった）。中身が変わったことはステップ名とコメントで示す（`gate` ジョブが Step ごとに中身だけを入れ替えているのと同じ規約で、適用はゲートジョブに限らない）。§14 の「PR 前に通すローカル検証」は `npm run gate:step7` と `npm run build`（ゲートは常に実装済みの最新 Step のものを回す。`docs/roadmap.md` ゲート運用ルール 2）。

**major 更新を意図的に保留している依存が 3 つある（`.github/dependabot.yml`）。**

- **`@types/node`（npm）と `node` ベースイメージ（docker）**: 型と出荷先のランタイムがずれても lint も typecheck もテストも通る（**CI の緑が判断材料にならない fail-open**）ので、「ランタイムを上げる判断」の側で一緒に上げる。解除条件は上流ではなく人の判断なので期限切れの検査は持たず、**保留そのものの消失・重複・効きすぎ**を `tests/dependabot-runtime-hold-guard.test.ts` が見る（解除の運用で消える eslint / typescript のガードとは別ファイルにしてある）。
- **`eslint` の 9 → 10**: `eslint-config-next` が引き込む `eslint-plugin-react` / `eslint-plugin-import` / `eslint-plugin-jsx-a11y` が peer で `^9` までに制限しており、10 では削除済み API を呼ぶため `npm run lint` が必ず落ちる。
- **`typescript` の 5 → 7**: lint の経路に載る `typescript-eslint` / `@typescript-eslint/*` が peer で `typescript >=4.8.4 <6.1.0` を、型生成の `openapi-typescript` が `^5.x` を宣言しているため、**`npm ci` が ERESOLVE で落ちる**（実測: Dependabot の PR #2 は gate / migrate-and-build / docker-smoke の 3 ジョブすべてがインストールの時点で失敗した）。

**どの `ignore` も消さず、`package.json` の版を手で上げない。** `eslint` / `typescript` の解除条件（上流が揃って次の major を許すこと）は `tests/dependabot-eslint-guard.test.ts` / `tests/dependabot-typescript-guard.test.ts` が **`package-lock.json` の解決済み `peerDependencies` から導いて**判定する（`package.json` の major を見る形では、保留が効いている限り値が動かないので解除条件が永久に発火しない）。**見張る依存も、判定に使う版も手書きしない** — typescript 側は「必須 peer で typescript を縛っている依存」と「解決済み版の次の major」をどちらもロックファイルから導く（0 件しか読めなければ fail-closed で落とす）。**候補の版を直書きすると保留の範囲より判定が狭くなる**: `ignore` はすべての major を止めるのに、判定だけが `7.0.0` を見ていると、6.x の保留理由（`openapi-typescript` の `^5.x` 1 件だけ）が消えても緑のままで 6.x が永久に抑止される。落ちたら**そのまま削除してよいとは限らない** — `ignore` はすべての major を止めているので、次の major だけが通るようになった状態で消すとさらに上の major が入って同じ ERESOLVE が戻る。失敗文言が上の major の状況まで出すので、「削除する」か「`versions` で範囲を絞る」かを見て決める。

`npm audit` の high 0 はゲートの一部。Prisma 7.10 の CLI が固定する推移依存（`deepmerge-ts` / `mysql2`）の high は `package.json` の `overrides` で解決版へ差し替えている（この API は PostgreSQL しか使わず、`mysql2` は実行時に到達しない）。**`source-map-js` も同じ扱い**で、`next` → `postcss` と `prisma` → `@prisma/config` → `c12` → `magicast` の 2 経路から high の版が入る（どちらもビルド時のソースマップ処理で、実行時の経路には乗らない）。**Step6 で入った問題ではない** — `git stash` で差分を外しても同じ勧告が出ることを確かめてから `overrides` を足した。**上流 (`@prisma/config` / `prisma`) はこれらを完全一致でピンしているので、`overrides` はそのピンを跨いで major を上げている**（現状 `prisma generate` / `migrate deploy` は動作を確認済み）。Prisma を上げて上流が解決版を取り込んだら `overrides` を外す。外す前に Prisma を大きく上げるときは、`overrides` を外した状態で `npm audit` と `prisma migrate deploy` の両方を確かめる。

## 3. アーキテクチャ

**スタック:** Next.js 16 App Router, React 19, TypeScript strict, Prisma 7 + `@prisma/adapter-pg` + PostgreSQL 16, Zod 4, Vitest, openapi-typescript。

### 正本と生成物

- `docs/spec.md` — ユースケース 10 件（`### UC-NN` 見出し）・ER 図（mermaid）・API 一覧。`tests/docs-gate.test.ts` が件数と節の存在を固定する。
- `docs/roadmap.md` — 8 Step の成果物・受け入れ基準・状態。`docs/adr/NNNN-*.md` — 設計判断（ステータス行必須）。
- `docs/overview.md` — **全体像の読み物（正本ではない）。** 初見の読者が「何のためのシステムで、どう組んであるか」を 1 枚で掴むための図つきの案内で、README 冒頭が最初にここへ送る。**動く数値（テスト件数・実測ミリ秒・しきい値）を書き写さず、構造の一覧（役割・操作・プラン等）を書くときは必ず正本を名指しする** — この文書を読む検出網は**ほぼ無い**ので（`tenantId` の例外の件数と名前だけは `tests/docs-gate.test.ts` が見る。他は誰も見ていない）、名指しの無い写しは黙って古くなる。**検出網の守備範囲を実際より広くも狭くも書かない**（PR #25 のレビューで 38 件の事実誤認が出たが、最も多かったのは「この網が見ている」という誇張で、読者が「ここは見られている」と誤認したまま穴へ実装を足す形だった）。
- `docs/index.md` — **`docs/` の唯一のカタログ。** 文書を 1 枚足す・改名するときはここを直す（README のディレクトリ表は `docs/` を 1 行で指すだけで、一覧の写しを持たない）。載せ忘れは `tests/docs-gate.test.ts` の「docs/ の入口の鮮度」が落とす（**この取り残しは実際に起きた** — PR #25 の直前は `api.md` / `deploy.md` / `known-issues.md` / `load-test.md` / `screenshots/` の 5 件が載っておらず、同 PR で手で直した。手で直すだけでは次も同じことが起きるので検査を足した）。**リンクの妥当性を見ようとして Markdown の文法を正規表現で再実装した版が 6 巡にわたって穴と誤検知を交互に出したので、高度（altitude）の誤りとして撤退した。自前の文法解析へ戻さないこと。** **この検査が何を見て何を見ていないかは同テストの `docs/ の入口の鮮度` の冒頭コメントが唯一の正本で、要約をここへ書き写さない**（守備範囲の説明を 2 か所に持つと、片方が実態より広いことを言い続け、読者が穴へ実装を足す）。
- `openapi/openapi.yaml` — REST API 契約（OpenAPI 3.1）。`npm run gen` → `src/generated/openapi.d.ts` → `src/lib/api-types.ts` がアプリ側の名前で再公開する。Route Handler の型はここから取り、生成物のパスを直接書かない。`tests/openapi.test.ts` が operationId の一意性・タグの宣言・認証が要る全オペレーション（GET 含む）の 403 宣言を固定する。**新しいエンドポイントは「定義 → `gen` → 実装 → API テスト」の順**（ADR-0003）。
- `prisma/schema.prisma` — 生成先は `src/generated/prisma`。**enum の正準は `src/domain/types.ts`**（`as const` で定義し Prisma の実行時コードに依存しない。Prisma 側の enum と一致することは `tests/domain-enums.test.ts` が固定する）。生成物への直接 import は **`src/` 配下に限って** ESLint が禁止する（**エイリアス形 `@/generated/prisma` だけでなく相対パス形 `../generated/prisma` も**。エイリアスだけを禁じると書き方 1 つで素通りする）。`src/` 内で許すのは結線箇所の `src/lib/prisma.ts` / `src/lib/prisma-client.ts` と prisma アダプタ `src/data/adapters/prisma/` だけ（`ignores` に 3 件）。**`tests/` は規則の対象外**で（`files` が `src/**/*.{ts,tsx}` なので `ignores` による例外ではない）、`tests/domain-enums.test.ts` が正準との一致を固定するためにそこから直接 import している — **規約違反として消すとその検査が成り立たない**。マイグレーションは `prisma/migrations/`（初期は `prisma migrate diff --from-empty --to-schema` で生成。以降は Docker が無い環境でも `--from-schema <直前の schema.prisma> --to-schema prisma/schema.prisma --script` で差分 SQL を作れる）。

### Prisma 7 の結線

`PrismaClient` を直接 `new` せず、`src/lib/prisma-client.ts` の `createPrismaClient()` を使う（アプリの singleton `src/lib/prisma.ts`・seed・将来の契約テストがすべて経由する）。`src/lib/prisma.ts` の `prisma` は Proxy 経由の**遅延生成**で、DB を触らないユニットテストが import しただけでは接続文字列を要求しない。接続文字列と seed コマンドは `prisma.config.ts` に集約し、`.env` は Next.js 以外の入口（`prisma.config.ts` / `prisma/seed.ts` / `scripts/` 配下の CLI とベンチ）が各自 `dotenv/config` で読む。`DATABASE_URL` 未設定は fail-closed で落とす。接続文字列の `?schema=` は**アダプタの `schema` オプションと接続時の `search_path` の両方**へ反映し、未指定なら `public` を明示的に固定する（片方だけだと Prisma CLI と実行時クライアントが別スキーマを向き、`SELECT 1` の生存確認は通るのに全クエリが落ちる）。**ただし CI が確かめられるのは「読み込みが例外を投げないこと」までで、値が入るかは一度も確かめていない** — `import 'dotenv/config'` 自体は `db:deploy` / `db:seed` を通じて毎回走る（なので import 時に throw する退行なら 3 ジョブとも赤くなる）が、`.env` は `.gitignore` と `.dockerignore` の両方で除外され、CI は `DATABASE_URL` をワークフローの `env:` で直接渡すので、**毎回「存在しない `.env`」を読んで何も入れずに終わる**。つまり**値の注入が壊れる退行だけは CI が緑のまま通す**（`@types/node` と docker の `node` を保留している「CI の緑が判断材料にならない fail-open」と同じ形。ただしこちらは保留もガードも置いていない）。

**この穴は `tests/dotenv-env-loading.test.ts` が塞いでいる** — 一時ディレクトリに `.env` を置いた子プロセスで実際に `dotenv/config` を読ませ、(a) 値が `process.env` へ届くこと（引用符つき・素の両方）、(b) **既に設定済みの環境変数を上書きしないこと**、(c) **`.env` が無くても import が例外を投げないこと**（CI が毎回踏んでいるのはこの状況）を見る。子には**素の `import 'dotenv/config'` を書かせる**（一時ディレクトリへ `node_modules` の symlink を張る）— 絶対パスで直接読ませると exports map を迂回し、**5 つの入口が実際に通る指定子の解決を一度も試さないテスト**になるため。(b) を固定する理由は**運用の側**で、ベンチも契約テストも `DATABASE_URL='…_contract' npm run bench:usage` のようにコマンドラインで接続先を指定して動かすので、上書きする版に変わると手元に `.env` がある開発者でその指定が黙って無視される。**安全性の話ではない** — 専用 DB ガード（`scripts/lib/contract-database.mjs`）も `createPrismaClient()` も同じ `process.env.DATABASE_URL` を `import 'dotenv/config'` の**後に**読むので両者がずれることはなく、`.env` が勝てばガードが開発 DB を見て止める（fail-closed）。

**機械で見張れているのはそこまでで、import 時の副作用が増えていないかは人が見る。手順の実体は `tests/gate-scripts.test.ts` の `ALLOWED_BENCH_PACKAGES` のコメントが持つ**（18 での実測と、次に上げるとき何をどう測るかがそこに書いてある。ここからは一方向に参照するだけで、手順をこちらに書き写さない）。なお 17 → 18 で既定のパーサは変わっておらず（両版に同じ入力を解析させて 13 キーすべて一致することを実測）、実際に動いたのは**読み込み方の側**だった（exports から `./lib/cli-options` / `./lib/env-options` が落ちて preload の `dotenv_config_*` が効かなくなった）。**解析結果だけを見る確認では落ちない**ので、上のテストは取り込み口の側も見ている。接続文字列の `?schema=` は**アダプタの `schema` オプションと接続時の `search_path` の両方**へ反映し、未指定なら `public` を明示的に固定する（片方だけだと Prisma CLI と実行時クライアントが別スキーマを向き、`SELECT 1` の生存確認は通るのに全クエリが落ちる）。

**生 SQL は「パラメータ化された形」だけに閉じる。** `createPrismaClient()` が返すクライアントは `src/lib/raw-sql-guard.ts` の `guardRawSql()` で包まれており、`$queryRawUnsafe` / `$executeRawUnsafe` は呼んだ時点で throw、`$queryRaw` / `$executeRaw` はタグ付きテンプレート以外の呼び方と、パラメータにならない値（`Prisma.raw` / `Prisma.sql` が返す SQL 断片）の埋め込みを拒否する。`$transaction` のコールバックが受け取るクライアントも同じ包みへ入れる（**実際に生 SQL を書いているのは行ロックのある `$transaction` の中**なので、そこを素通しにすると守るべき場所がまるごと外れる）。**この判定を静的解析へ戻さないこと** — 綴りを走査する検出網は 1 段の間接化で崩れ、実測では `const { raw } = Prisma` と分割代入して変数に入れた断片を埋め込むだけで、構文検査も ESLint も素通りし、URL のパスパラメータから任意 SQL を実行できた（`pg_sleep` が実際に効き、他テナントのユーザーの存在判定もできた）。`tests/raw-sql.test.ts` と ESLint の `no-restricted-syntax` は「危険な書き方が直接の綴りで増えたことに早く気付く」ための二次的な網で、証明ではない。ガードの挙動は `tests/raw-sql-guard.test.ts` が、本番クライアントへの結線は契約テストが固定する。**閉じるのは「包んだクライアントから**通常のプロパティ読み取りで**値を取る経路」だけ** — Proxy のトラップは `get` 1 つなので、**プロパティの読み取り以外の内省は包まれない**。守備範囲の外は 2 つあり、どちらも実測済み: **(1) プロトタイプ経由**（`Object.getPrototypeOf(guarded).$queryRawUnsafe.call(client, sql)`。生成物の `PrismaClient` は生 SQL のメソッドを**プロトタイプ上**に持ち、`src/lib/prisma.ts` の遅延生成 Proxy も `getPrototypeOf` を実体へ転送する。`getPrototypeOf` トラップで包み直すことはできるが、**返すのが別オブジェクトになるため `instanceof` が成立しなくなる**ので意図的に開けてある。`Object.getOwnPropertyDescriptor(guarded, name).value` も同じ）、**(2) 2 つ目のクライアントを作る経路**（`new PrismaClient(...)` や `new (prisma.constructor)(...)`）。どちらも追いかけると綴りを追う形に戻るので追わず、「クライアントの生成は `createPrismaClient()` だけ」という規約・二次的な静的の網（`tests/raw-sql.test.ts` と ESLint は**レシーバを問わず** `$queryRawUnsafe` / `$executeRawUnsafe` の綴りを落とすので、(1) の素直な書き方はそこで赤くなる＝実測）・レビューで守る。**「このガードがあるから生 SQL は必ずパラメータ化される」と読み切らないこと。** 境界そのものは `tests/raw-sql-guard.test.ts` が固定しているので、閉じ方を変えるときはそちらも直す。

### レイヤ構成（索引）

**この節は索引で、詳細の正本は [`docs/implementation-notes.md`](./docs/implementation-notes.md)。** 不変条件・設計判断・
「どの変異が実測で素通りしたか」はあちらが持つ。**コードを書く前に、触る層の節を開くこと**
（1 行の責務だけでは守るべき形が分からない）。**行を足すときは両方へ足す** — 索引だけに
足すと指す先が無く、あちらだけに足すと誰も辿り着けない。**この表の行と向こうの節は 1 対 1 で、
`tests/docs-gate.test.ts` が両方から導いて突き合わせる**（片方だけに足した差分は落ちる）。

| 対象 | 責務（1 行） |
| --- | --- |
| [`src/proxy.ts`](./docs/implementation-notes.md#srcproxyts) | 全リクエストの入口（Next.js 16 の `proxy` ファイル規約。**エクスポート名は `proxy` 固定**）。壊れたパスをルーティングの前に落とす |
| [`src/app/*`](./docs/implementation-notes.md#srcapp) | App Router。API は `src/app/api/v1/*`（OpenAPI の `servers.url` に合わせる） |
| [`src/data/`](./docs/implementation-notes.md#srcdata) | **Ports & Adapters**（ADR-0006）。契約 `ports/`・本番 `adapters/prisma/`・テスト `adapters/memory/` |
| [プロキシ（Step2）](./docs/implementation-notes.md#プロキシstep2) | 上流への中継とコストの記録。**課金された呼び出しを台帳から落とさない**のが最優先 |
| [品質評価（Step3）](./docs/implementation-notes.md#品質評価step3) | 2 段（対象へ投げる → judge が採点）。上流の結線は中継と共有 |
| [ガードレール・監査ログ（Step4）](./docs/implementation-notes.md#ガードレール監査ログstep4) | しきい値の判定と停止。入口は `evaluateGuardrails` **だけ**で、3 つの起点が同じ関数を通る |
| [監査ログ（Step4）](./docs/implementation-notes.md#監査ログstep4) | 追記専用の証跡。書き込みは `recordAudit` **1 か所経由**（鍵が無ければ fail-closed） |
| [レート制限と予算（Step4 / ADR-0007 の宿題）](./docs/implementation-notes.md#レート制限と予算step4--adr-0007-の宿題) | 枠は DB の共有ストア（ADR-0015）。キーはテナント、上限はプラン別 |
| [保守の定期実行（ADR-0016）](./docs/implementation-notes.md#保守の定期実行adr-0016) | 定期掃きと記録の回収（プラットフォーム限定）。**スケジューラは同梱しない** |
| [通知（Step4）](./docs/implementation-notes.md#通知step4) | Webhook とメール。**宛先は環境変数だけが決める**（SSRF の入口を作らない） |
| [画面（Step5）](./docs/implementation-notes.md#画面step5) | ログインとダッシュボードの 4 画面。集計は `dashboard/summary.ts` の 1 か所 |
| [プランと課金（Step6）](./docs/implementation-notes.md#プランと課金step6) | 上限と可否の正本は `PLAN_LIMITS`。課金は受信と参照だけ（Stripe の SDK は入れない） |
| [リリース準備（Step7）](./docs/implementation-notes.md#リリース準備step7) | デプロイ設定・API リファレンス・負荷試験レポート・既知バグ。基準の正本は `step7-criteria.mjs` |
| [観測性（ログとメトリクス。ADR-0014）](./docs/implementation-notes.md#観測性ログとメトリクスadr-0014) | **`console` を呼べるのは `src/lib/log.ts` だけ**。出口は 1 行 1 JSON と `/metrics` |
| [`src/domain/`](./docs/implementation-notes.md#srcdomain) | Prisma / Next 非依存の純粋ロジック（許可表・料金表・しきい値判定） |
| [`src/lib/`](./docs/implementation-notes.md#srclib) | 横断インフラ（`describe-error` ・ `api/` ・ `audit/` ・ `guardrail/` ・ `notify/` ほか） |
| [`scripts/bench-*.ts`](./docs/implementation-notes.md#scriptsbench-ts) | 時間を測る受け入れ基準。しきい値は `scripts/lib/stepN-criteria.mjs` が唯一の定義 |
| [`scripts/gate-stepN.mjs`](./docs/implementation-notes.md#scriptsgate-stepnmjs) | Step ごとの受け入れ基準の検査（ADR-0004）。数値はゲート本体に書かない |
| [`prisma/`](./docs/implementation-notes.md#prisma) | スキーマ・マイグレーションと seed（値・投入手順・入口の 3 つに分ける） |
| [カバレッジ（Step6 の受け入れ基準④）](./docs/implementation-notes.md#カバレッジstep6-の受け入れ基準) | 測るのはロジック層のみ。定義の正本は `scripts/lib/step6-criteria.mjs` |
| [`tests/`](./docs/implementation-notes.md#tests) | Vitest（`environment: 'node'`）。API テストは memory アダプタで Route Handler を直接呼ぶ |

どの層にも掛かる禁じ手（理由と抜け道の実測はそれぞれの節）:

- **`console` を直接呼ばない** — すべて `logEvent('<語彙のキー>', describeError(error)?)` を通す（[観測性](./docs/implementation-notes.md#観測性ログとメトリクスadr-0014)）。
- **Route Handler は必ず `route()` で包む** — 例外は理由付きの表に登録する（[`src/app/*`](./docs/implementation-notes.md#srcapp) ・ [プランと課金](./docs/implementation-notes.md#プランと課金step6)）。
- **`src/` で Prisma を直接 import してよいのは結線 2 本と prisma アダプタだけ**（[`src/data/`](./docs/implementation-notes.md#srcdata)）。
- **生の SQL はタグ付きテンプレートだけ** — `$queryRawUnsafe` / `$executeRawUnsafe` / `Prisma.raw` は実行時のガードが落とす（理由と**ガードの外側に残る抜け道**は下の「Prisma 7 の結線」）。
- **時刻は記録側の時計が決める** — 比較の境目を引数で渡せる形そのものを作らない（[保守の定期実行](./docs/implementation-notes.md#保守の定期実行adr-0016) ・ ADR-0015 / ADR-0016）。

### マルチテナントと RBAC（設計の不変条件）

- テナントに属する資源が `tenantId` を持つ行スコープ方式（ADR-0002）。**例外は 3 つで、正本は `docs/spec.md` §3**（`EvaluationCase` は列を持たず親の `EvaluationSet` 経由、`BillingEvent.tenantId` は **nullable**、`RateLimitHit` は**テナントに属さない枠（`platform`）も数えるので列ごと持たない**。nullable のほうは型が通るので、`where: { tenantId }` を差し込んでも顧客 ID を引けなかった行が黙って落ちる — 集計で非 null を前提にしない）。導出との一致は `tests/docs-gate.test.ts` が `prisma/schema.prisma` から見る。**Server Action / Route Handler は冒頭で認証情報から `tenantId` を取り出し、`where` に必ず差し込む**（足し忘れはクロステナント漏洩）。他テナントの資源は 404 で隠す（403 だと存在が漏れる）。
- 書き込み系の API は RBAC 違反を 403 で返し、OpenAPI 定義にも `403` を宣言する。認証は Bearer 2 種（ADR-0005）: ユーザートークン（`UserToken`。ハッシュ保存・既定 90 日・失効/期限切れ/ユーザー無効化はすべて同じ 401）と、`GET/POST /tenants` 専用のプラットフォーム管理者トークン（環境変数 `PLATFORM_ADMIN_TOKEN`、32 文字以上。未設定・短すぎは「存在しない」扱い = fail-closed。テナント内の資源には閲覧も含め 403）。`admin` ロール限定の操作（ユーザー招待・役割変更・無効化・トークン発行/失効）は `requireAdminRole` で役割そのものを比べる（`role === 'admin'` を許す唯一の用途）。**資格情報の系統は混ぜない**: `authenticate()` は API キーを受け付けず（有効なキーでも 401）、`authenticateApiKey()` はユーザートークンを受け付けない。**両向きとも検査する** — 逆向きだけが 6 件で守られていて、`authenticate()` に 1 行足して API キーを受理させる変異は実測で全件緑のまま通り、ユーザー向け API 上に「そのキーは有効か・紐づくエージェントは停止中か」を 403 で答えるオラクルが生えた（だから 401 であることまで固定する）。自分自身の無効化と最後の有効な `admin` の降格・無効化は 409。ユーザーは削除せず無効化する（`disabledAt`）。
- **契約プランは上限と機能の可否を決める**（Step6）。`Tenant.plan` を認証時に Principal へ載せ、上限は `src/domain/plan.ts` の表から引く（数値を各所に書かない）。**プランを変えられるのは Webhook とプラットフォーム管理者だけ**で、どちらも監査ログに残す。
- 金額はマイクロ USD の整数（`BigInt`、1 USD = 1,000,000）で持ち、JSON では文字列で運ぶ（浮動小数誤差を避ける）。
- API キーは SHA-256 ハッシュ（`keyHash`）と先頭数文字（`prefix`）だけを保存し、平文は発行応答でしか返さない。
- 監査ログ（`AuditLog`）は追記専用で、**改ざん検知（HMAC のハッシュ連鎖）付き**（Step4 で実装。詳細は上の「監査ログ（Step4）」と ADR-0010）。削除の規則（履歴は `Restrict`、設定は `Cascade`、`actorId` は `Restrict`、子テーブルは複合 FK `(tenantId, 親id)`）は `docs/spec.md` §3「削除の規則」が正本。
- エージェントの状態は `active` / `stopped`（手動）/ `suspended`（ガードレールによる自動停止。復帰は `stop` 権限の `resume` で、手動停止・自動停止のどちらからも `active` へ戻す）。**人が API から直接 `suspended` にする操作は無い**（自動停止はアダプタの中だけ。入れると「誰かが手で suspended にした」記録と自動停止の記録が区別できなくなる）。**手動停止を自動停止で塗り替えない**（既に `stopped` / `suspended` なら状態を変えない。「誰が止めたか」が読めなくなる）。

### 見せ方（§15 の具体化）

- スタック形態は「DB/常駐サーバーが必要な Web」: README 冒頭のデモブロックは**デモ動画必須**、公開 URL は任意。**現状は公開していない**（Step7 の成果物は Vercel/Supabase 向けのデプロイ設定までで、公開する場合の手順は `docs/deploy.md`）。README に未来形で「Step7 で用意する」と書かない — 全 Step が完了しているので、同じ画面の中で矛盾する。
- **撮影は `npm run capture:screenshots` が自動で行う**（`scripts/capture-screenshots.mts`）。スクショ 5 枚とデモ動画を `docs/screenshots/` へ置き、**ファイル名の正本は `STEP5_SCREENS`**（`scripts/lib/step5-criteria.mjs`）: `login.png` / `dashboard.png` / `agents-list.png` / `agent-detail.png` / `incidents.png`。使うのは E2E と同じ仕込み（`e2e/lib/fixture.ts`）なので**シードデータだけ**が写り、実在のメールアドレスは入らない。
- **形式は GIF ではなく webm**（Playwright 同梱の録画をそのまま使う。この環境に `ffmpeg` が無く、§15 は「GIF/動画」なので動画で満たせる）。内容は「ログイン → ダッシュボード → インシデント → 停止 → 復帰 → 解決 → ダッシュボード」の 1 本。
- **撮影のブラウザ文脈は `locale: 'ja-JP'` / `timezoneId: 'Asia/Tokyo'` を明示する** — 既定のままだと日付が `10/04/2026` の形で写る（実測）。
- **認証が要る画面と要らない画面で文脈を分け、開いた URL が意図どおりかを確かめる** — ログイン済みの文脈で `/login` を開くとダッシュボードへリダイレクトされ、**`login.png` が `dashboard.png` と同じ絵になる**（実測。スクショが 1 枚静かに嘘になる）。
- **`networkidle` を待たない** — Next の本番サーバーは接続を開いたままにするので 30 秒で時間切れになる（実測）。`load` ＋ 短い静止待ちで撮る。
- UI を変えた PR では該当するスクショを同じ PR で撮り直す（§15）。

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
- マルチテナントは行スコープ（**テナントに属する資源**が `tenantId` を持つ、ADR-0002）。**「全テーブル」ではなく、DB 制約で守られる範囲も表ごとに違う。** 取りうる形は 3 つ: (a) 多くの子テーブルは複合 FK で親の `(tenantId, …)` を参照するので「別テナントの親を指す行」をDB が拒む、(b) **単一列の FK で親を指す列もあり、そこはアプリ側のチェックだけが防御**（監査ログの操作者 ID がその例。DB が拒むと思って手当てを省くと、別テナントの利用者の行為として追記専用の表に残り、後から直せない）、(c) 親経由でしか到達しない表は `tenantId` の列を省くことがあり、そのときは**親を `tenantId` で絞ってから辿る**（子の外部キーだけで引くとクロステナント漏洩。§9 の「クエリに必ずテナント条件を差し込む」をこの形で満たす）。加えて `tenantId` が **nullable** な列もあり（受信した課金イベントがその例）、そこは**型が通ってしまう**ので `where: { tenantId }` を差し込んでも引けなかった行が黙って落ちる — 集計で非 null を前提にしない。**どの表がどの形で、親に張る一意索引が何なのかは `docs/spec.md` §3 と `prisma/schema.prisma` が正本**で、表の一覧も件数も索引の形もここへ写さない（上は「どういう形があるか」の例示。参照先の列の並びは表ごとに違うので、索引の形を写すとそのまま適用できない）。他テナントの資源は 404 で隠す（403 だと存在が漏れる）。
- RBAC は `viewer` / `operator` / `admin` × `view` / `execute` / `stop` の許可表 `src/domain/rbac.ts` が唯一の真実の源（不明なら拒否）。
- Prisma クライアントは `src/generated/prisma` に出力される。enum の正準は `src/domain/types.ts`（`as const` で定義し Prisma の実行時コードに依存しない。Prisma 側との一致はテストで固定）。生成物への直接 import は **`src/` 配下に限って** ESLint が禁止する（**エイリアス形 `@/generated/prisma` だけでなく相対パス形 `../generated/prisma` も**。エイリアスだけを禁じると書き方 1 つで素通りする）。`src/` 内で許すのは結線箇所の `src/lib/prisma.ts` / `src/lib/prisma-client.ts` と prisma アダプタ `src/data/adapters/prisma/` だけ（データ層は Ports & Adapters なので Adapter 側だけが生成物を触る。契約 `src/data/ports/`、本番 `adapters/prisma/`、テスト `adapters/memory/`。ADR-0006）。**`tests/` は規則の対象外**で（`files` が `src/**` なので `ignores` による例外ではない）、Prisma の enum と正準（`src/domain/types.ts`）の一致を固定する検査がそこから生成物を直接 import している — **実測で lint は通る。規約違反として消すとその検査が成り立たなくなる**。結線は `createPrismaClient()` に集約。生成物（`src/generated/`）はコミットしない。
- 金額はマイクロ USD の整数（`BigInt`）で持ち、JSON では文字列で運ぶ。API キーは SHA-256 ハッシュ（`keyHash`）と先頭数文字（`prefix`）だけを保存し、平文は発行応答でしか返さない。
