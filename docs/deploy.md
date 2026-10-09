# デプロイ（Vercel + Supabase）

Step7 の成果物。**自前のサーバーを持たずに公開する場合の手順**をここに置く。
Docker で動かす手順は README の「Docker で動かす」、ローカル開発は README の「セットアップ」。

> **この文書は「どう配備するか」だけを書く。** アプリ側の不変条件（fail-closed の設定・
> レート制限の単位・テナント境界）は `CLAUDE.md` §3 と各 ADR が正本で、ここには写しを置かない。

## 構成

| 役割 | サービス | 備考 |
| ---- | -------- | ---- |
| アプリ（Next.js 16 / App Router） | Vercel | 設定は `vercel.json`。`npm run gen` と `npm run db:generate` をビルド前に流す |
| PostgreSQL 16 | Supabase | 接続は 2 本（**実行時はプーラ経由・マイグレーションは直結**。下記） |

生成物（`src/generated/`）はコミットしないので、**ビルドコマンドで必ず生成する**。
`vercel.json` の `buildCommand` がそれを行う（`npm run gen` が OpenAPI の型、
`npm run db:generate` が Prisma クライアント）。生成を忘れると型が無いので `next build` が落ちる。

## 1. データベースを用意する

1. Supabase でプロジェクトを作る（リージョンは Vercel の配備先と近いところ）。
2. 接続文字列を 2 本控える。
   - **プーラ（Transaction mode, ポート 6543）** — アプリの実行時に使う。
     サーバーレスは 1 リクエストごとに接続を張るので、直結のままだと接続数の上限に当たる。
   - **直結（ポート 5432）** — `prisma migrate deploy` に使う。
3. 専用スキーマを使う場合は `?schema=app` を付ける（既定は `public`）。
   **この指定は「アダプタの schema オプション」と「接続時の `search_path`」の両方へ反映される**
   （`src/lib/prisma-client.ts`）。片方だけだと `SELECT 1` の生存確認は通るのに全クエリが落ちる。

### マイグレーションの適用

**アプリの起動時には適用しない**（サーバーレスでは同時起動が重なってロックを取り合う）。
**直結の接続文字列**を使って、手元か CI から 1 回だけ流す。

```bash
DATABASE_URL='postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres?schema=app' \
  npm run db:deploy
```

> **`prisma migrate deploy` をプーラ（6543）へ向けない。** Transaction mode の pgbouncer は
> prepared statement とアドバイザリロックを保てないので、マイグレーションが途中で失敗しうる。
> **プーラの接続文字列は実行時（`DATABASE_URL`）だけに使う。**
>
> アプリは `DATABASE_URL` しか読まない（`prisma.config.ts` も同じ値を読む）。
> **`DIRECT_URL` のような 2 本目の環境変数は無い**ので、マイグレーションのときだけ
> `DATABASE_URL` を直結の値に差し替えて流す。

### デモシードを入れる

```bash
DATABASE_URL='<直結の接続文字列>' npm run db:seed
```

投入されるのは `prisma/seed-data.ts` が持つデモデータ（**値の正本はそこ 1 か所**）:
デモテナント 1 つ（契約プランは `pro`）・ユーザー 2 人（`admin@example.com` と
`viewer@example.com`。**実在しないドメインのアドレスだけ**）・サンプルエージェント 1 つ。
seed は冪等なので何度流してもよい（CI が 2 回流して確かめている）。

**ログイントークンは seed では作らない**（平文を DB にもログにも残さないため）。
開発用 CLI で発行する:

```bash
DATABASE_URL='<直結の接続文字列>' npx tsx scripts/issue-user-token.ts --email viewer@example.com
```

公開デモでは**閲覧専用（`viewer`）のトークンだけを配る**（§15 のデモ環境の最小権限）。

## 2. 環境変数を設定する

**名前と意味の正本は `.env.example`**（`docker-compose.yml` も `tests/deployment-invariants.test.ts`
が `.env.example` から導いて素通し漏れを落としている）。Vercel のプロジェクト設定へ入れる値:

| 変数 | 必須 | 入れる値 |
| ---- | ---- | -------- |
| `DATABASE_URL` | **必須** | **プーラ（6543）**の接続文字列 |
| `PLATFORM_ADMIN_TOKEN` | テナントを作るなら必須 | 32 文字以上の乱数（`openssl rand -base64 48`） |
| `AUDIT_HMAC_SECRET` | **必須** | 32 文字以上の乱数。**未設定だと人の操作（停止・復帰・解決・ルール登録）が 503 になる** |
| `STRIPE_WEBHOOK_SECRET` | 課金を繋ぐなら必須 | 事業者が発行する `whsec_…`。未設定だと受信を 503 で断る |
| `METRICS_TOKEN` | 監視を繋ぐなら必須 | 32 文字以上の乱数。**収集エージェント専用の読み取り用**（`PLATFORM_ADMIN_TOKEN` を使い回さない）。未設定だと `/metrics` は 503 |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | 中継・評価を使うなら | 上流の資格情報。**クライアントからは受け取らない** |
| `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` | 任意 | 省略すると公式のエンドポイント |
| `PROXY_RATE_LIMIT_PER_MINUTE` | 任意 | 省略すると定数の既定値 |
| `JUDGE_PROVIDER` / `JUDGE_MODEL` | 任意 | 採点に使う LLM。綴り違いは既定へ倒さず 503 |
| `NOTIFY_WEBHOOK_URL` / `NOTIFY_MAIL_WEBHOOK_URL` / `NOTIFY_SIGNING_SECRET` | 任意 | 通知。鍵が無ければ**送らない** |

**どれも未設定なら安全側に倒れる（fail-closed）** ので、「設定を忘れたまま動いてしまう」形は無い。
代わりに**その機能が 503 になる**ので、公開前に確かめる。

- `GET /api/v1/health` — `{"ok":true}`（DB 到達性込み）。
- **`AUDIT_HMAC_SECRET` の確認は「人の操作を 1 回行う」**。`POST /api/v1/agents/{id}/stop`
  が **200**（停止後のエージェント JSON）を返せば鍵が入っている（未設定なら 503）。
  **`GET /api/v1/audit-logs/verify` では確かめられない** — このエンドポイントは
  pro / enterprise 限定の機能ゲートの後ろにあり、新しく作ったテナントは既定で `free` なので、
  鍵が入っていても **403** が返る（鍵の有無と区別が付かない）。連鎖の検証まで確かめたいなら、
  先にプラットフォーム管理者の `PATCH /api/v1/tenants/{tenantId}` でプランを上げる。

> **上流 LLM を繋ぐなら、ベンダー側の月次利用上限（spend limit）を必ず設定する。**
> アプリ側の歯止めは「テナント単位のレート制限」と「エージェントの予算」だが、
> 予算を設定していないエージェントには上限が無い（`.env.example` の該当箇所にも書いてある）。

## 3. 配備する

1. リポジトリを Vercel へ接続する（`vercel.json` があるので追加設定は不要）。
2. 上の環境変数を Production / Preview に入れる。
3. デプロイする。
4. `GET /api/v1/health` が `{"ok":true}` を返すことを確かめる（DB 到達性も含む）。

## サーバーレスで配備するときの制限（必ず読む）

| 項目 | 内容 | 出典 |
| ---- | ---- | ---- |
| **レート制限がインスタンスごとになる** | 枠の保持はインプロセスの `Map`。複数インスタンスでは**台数分だけ緩くなる**（共有ストアは宿題） | ADR-0010 |
| **本文サイズ・タイムアウト・未対応メソッド** | アプリ手前のリバースプロキシの責務。Vercel の既定で足りるかを配備先ごとに確認する | ADR-0005 / ADR-0007 |
| **関数の実行時間上限** | 上流 LLM の中継は 1 リクエストが長い。プランの `maxDuration` を超えると 504 になるので、必要なら `vercel.json` の `functions` で延ばす | — |
| **接続数** | プーラ（Transaction mode）を使う。直結のままだと Supabase の接続上限に当たる | 上記「1.」 |

これらは「バグではなく設計上そうしてある／後の課題」なので、
`docs/known-issues.md` の「既知の制限」にも同じ一覧がある。

## 公開デモを出す場合（§15）

- **書き込みを配らない**: 配るトークンは `viewer` だけ。`PLATFORM_ADMIN_TOKEN` は配らない。
- **本番と分離する**: 環境変数・シークレット・DB をデモ専用にする（本番と共有しない）。
- **定期リセット**: `npm run db:seed` は冪等なので、スケジュール実行で初期状態へ戻せる
  （テナントごと作り直す場合は Supabase 側で DB を切り直す）。
- **上流は繋がない**か、繋ぐなら spend limit を必ず設定する（中継は従量課金）。

## 動作確認（配備後）

`docs/api.md` の一覧と README の「5 分で試す」をそのまま使う。所要時間の基準
（クリーン環境から 5 分以内）は CI の `docker-smoke` ジョブと `npm run bench:demo-ready` が
機械で確かめている（解釈は `docs/roadmap.md` の「Step7 の受け入れ基準の解釈」）。

## 監視を繋ぐ（配備後）

出口は 2 つ（[ADR-0014](./adr/0014-observability.md)）。

### 1. ログ（1 行 1 JSON）

アプリは `stderr` へ 1 行 1 JSON を書く。収集は配備側（Vercel のログドレイン、
コンテナのログドライバ）に任せる — アプリから外へ送る経路は持たない。

```json
{"ts":"2026-10-09T01:02:03.000Z","level":"error","event":"proxy.upstream_call_failed","message":"<LOG_EVENTS が持つ文言>","error":{"name":"TypeError","cause":{"code":"ECONNREFUSED"}}}
```

**警報は `event` の等値で組む**（文言は推敲で変わる）。語彙の一覧は
`src/lib/log.ts` の `LOG_EVENTS` が正本で、`level` は `error` / `warn` の 2 値。
`error` は「運用者が対処すべき」、`warn` は「縮退して続けた」の意味。
上の例で `message` を伏せてあるのは**意図したもの**で、文言は正本の側で推敲してよい
（ここに実際の文を写すと、推敲するたびにこの例だけが古くなる。`event` と `level` は
警報の条件そのものなので写してある。この 2 つが語彙と一致することは
`tests/docs-gate.test.ts` が `LOG_EVENTS` から導いて照合する）。

### 2. メトリクス（Prometheus のテキスト形式）

```bash
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" https://<配備先>/api/v1/metrics
```

- **専用の読み取りトークン（`METRICS_TOKEN`）だけ**が読める。32 文字以上の乱数を
  `.env` へ置き（生成例 `openssl rand -base64 48`）、同じ値をスクレイプする側へ渡す。
  **未設定・短すぎなら 503 で誰も読めない**（fail-closed）。
- **`PLATFORM_ADMIN_TOKEN` を代わりに使わないこと。** あちらは `POST /api/v1/tenants`
  （応答に**新しいテナントの admin トークンの平文**が載る）と `PATCH /api/v1/tenants/{id}`
  （プラン・課金の紐付けの変更）も通る。収集エージェントがするのは数字を読むことだけなので、
  同じ値を配ると収集側の設定ファイルや収集サーバの侵害がそのままテナント作成・プラン変更の
  権限になる（§15 の「このトークンは配らない」と同じ理由）。
- **テナントの利用者には見せない**（値はテナントごとに分かれていないので、他テナントの
  活動量が読める）。テナントが見るべき数字は画面と `GET /api/v1/usage/daily`。
- **値はインスタンスごと。** 足し合わせるのはスクレイプ側で、サーバーレスではインスタンスが
  短命なので `agentops_process_start_time_seconds` / `..._uptime_seconds` を見て
  「カウンタが 0 へ戻った」ことを判別する。
- **数えるのは `route()` を通る経路だけではない。** 未認証の受信 Webhook・`GET /health`・
  画面側の CSV・`/metrics` 自身も同じ系列に乗るので、`agentops_http_responses_total{status="401"}`
  の増加で署名鍵の設定ミスやなりすましの総当たりが分かる。
- **ただし `agentops_http_responses_total` は「アプリが返す HTTP 応答のすべて」ではない。**
  乗るのは Route Handler（`src/app/**/route.ts`）の応答だけで、**数えない種類が 3 つある**
  （正本は `src/lib/metrics.ts` の `UNCOUNTED_RESPONSE_SOURCES`）。この系列だけを見て
  「他の通信はすべて覆われている」と読まないこと。
  - 入口（`src/proxy.ts`）が percent-decode できないパスへ返す 404。<!--uncounted:entryProxy-->
    入口は Route Handler とは**別のモジュール実体**で評価されるため、そこで数えてもこの
    カウンタには入らない（本番ビルドで実測）。代わりに `entry.undecodable_path` を
    **1 プロセスに 1 度だけ**ログへ出すので、起きたことは分かる（**同じ理由でその行数も
    `agentops_log_events_total` には現れない**ので、警報の条件はログ側の `event` で書く）。
    同種の要求が続いているかは**前段のアクセスログ**で見る。
  - 画面の描画（`src/app` 配下の `.tsx`）。<!--uncounted:pageRender-->
    Next.js は描画の応答を Route Handler として扱わないので、包める入口が無い。
    画面の通信量・エラー率は**前段のアクセスログ**で見る。
  - Server Action（`'use server'` のモジュール）。<!--uncounted:serverAction-->
    同じく包める入口が無い。**ダッシュボードのログインの拒否はログに出る**ので、総当たりは
    `session.login_rejected` の増加で警報にできる（別オリジンからの送信は
    `session.cross_origin_action`）。`agentops_http_responses_total` では見えない。
- **耐久する事実はここに出さない。** 利用量・コストは `GET /api/v1/usage/daily`、
  インシデントは画面と `GET /api/v1/incidents`、操作の記録は `GET /api/v1/audit-logs`。
