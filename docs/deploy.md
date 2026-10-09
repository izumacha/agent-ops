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
| **保守の定期実行は自分で繋ぐ** | スケジューラは同梱していない。繋がないと (a) 使われなくなったエージェントのエラー率・品質のルールが発火せず、(b) 二度と来ないキー（解約したテナント）のレート制限の記録が残る。繋ぎ方は下の「保守を定期実行する」 | ADR-0016 / ADR-0015 |
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

## 保守を定期実行する（配備後・必須）

`POST /maintenance/run` が 2 つの後片付けを行う（ADR-0016）。**どちらも「誰も呼ばないと
静かに効かなくなる」たち**なので、配備したら必ずスケジューラへ繋ぐ。

1. **ガードレールの定期掃き**。判定は中継と評価実行の直後に走るが、**集計窓から古い行が抜ける
   だけでしきい値を越える**ルールがある（エラー率は成功した古い呼び出しが抜けると分母が減って
   率が上がり、品質は良い実行が抜けると平均が下がる）。どちらも**使われなくなったエージェント**で
   起き、そのとき判定を起こす要求が無いので**繋がないと永久に発火しない**。
2. **レート制限の記録の回収**。`consume` が**そのキーの**期限切れを同じ操作で掃くので通常は
   膨らまないが、**二度と来ないキー**（解約したテナント）の行は残る。

### ティックの回し方

一巡は 1 要求では終わらない（1 要求でやる仕事に上限がある）。**`passComplete` が真になるまで
カーソルを送り返して繰り返す**ループは同梱のスクリプトが持っているので、スケジューラは
これを 1 回呼ぶだけでよい:

```bash
MAINTENANCE_BASE_URL=https://ops.example.com \
PLATFORM_ADMIN_TOKEN=... \
npm run maintenance:tick
```

| 環境変数 | 必須 | 内容 |
| ---- | ---- | ---- |
| `MAINTENANCE_BASE_URL` | ○ | アプリの入口（`/api/v1` までは付けない） |
| `PLATFORM_ADMIN_TOKEN` | ○ | この経路を叩ける唯一の資格情報（アプリへ渡しているものと同じ値） |
| `MAINTENANCE_AGENT_BUDGET` | — | 1 要求で判定するエージェント数（省略するとアプリ側の既定） |

**これらはアプリの環境変数ではない**（スケジューラ側で設定する）。だから `.env.example` には
載せていない — あちらは「アプリが読む設定」の雛形で、`docker-compose` の app へ素通しする
対象でもある。

**終了コードを見張ること。** 0 = 一巡を回し切った、1 = 設定不足・HTTP エラー・**判定の
取りこぼしが残っている**（`failed > 0`）。アプリ側は一巡を続けるために 200 を返すので、
**取りこぼしに気付けるのはこの終了コードだけ**。

### 間隔

**出発点は毎時**。短くすると判定の費用（エージェントごとに数クエリ）が増え、長くすると
「窓が過ぎてから発火するまで」の遅れが伸びる。適切な値はルールの `windowMinutes` と配備の
規模で決まるので、運用して調整する。

### 繋ぎ先の例

- **host の cron**（`docker compose` 配備）: `0 * * * * cd /srv/agent-ops && npm run maintenance:tick`
- **systemd timer**: `OnCalendar=hourly` のユニットから同じコマンドを起こす
- **GitHub Actions**: `on.schedule` のワークフローから `npm ci && npm run maintenance:tick`
  （`MAINTENANCE_BASE_URL` / `PLATFORM_ADMIN_TOKEN` をリポジトリの secrets に置く）
- **Vercel**: **Vercel Cron は使えない** — あちらは GET しか発行せず、この経路は副作用がある
  ので POST にしてある（§9「副作用のある操作を GET で行わない」）。上記のいずれか外部の
  スケジューラから回す。

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

**`console` のメソッドも深刻度に合わせる**（`warn` は `console.warn`、それ以外は
`console.error`。どちらも `stderr` で、行の形は同じ）。配備側のログ基盤はメソッドで
深刻度を付けるので、全部 `error` で出すと**利用者がログイン用トークンを 1 回打ち間違えた
だけで ERROR のレコードが立ち**、プラットフォーム側のエラー率の警報が鳴る（行の中の
`level` は `warn` なので、基盤の深刻度で見る運用者と文書どおり `level` で見る運用者で
答えが割れる）。**基盤側で絞るときも、アプリ側の条件は `event` で書く。**
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
- **レート制限は前段で掛ける**（受信 Webhook と同じ）。アプリ側の枠のキーは認証済みの主体から
  作るので、テナントを持たないこの経路にはキーが無い。照合は定数時間比較なので総当たりは
  トークンの乱数長に対して行うことになるが、**前段で経路ごとの上限を掛けておく**こと。
- **値はインスタンスごと。** 足し合わせるのはスクレイプ側で、サーバーレスではインスタンスが
  短命なので `agentops_process_start_time_seconds` / `..._uptime_seconds` を見て
  「カウンタが 0 へ戻った」ことを判別する。
- **ただしサーバーレス（この文書が主に案内する Vercel）では、引きに行く形の収集は成り立たない。**
  要求ごとにどのインスタンスへ届くかが決まるので、`GET /api/v1/metrics` へのスクレイプが
  読むのは**その 1 回を処理したインスタンスの表だけ**（多くの場合、そのスクレイプ自身の
  `GET` だけが乗っている）。他のインスタンスが処理した応答は 1 件も見えず、コールドスタート
  ごとに 0 へ戻る。したがって **`rate(agentops_http_responses_total{status=~"5.."}[5m])` の形の
  警報は、全要求が 500 でも鳴らない。**
  - **サーバーレスで数を見たいなら、警報は構造化ログの `event` で組む**（下の「ログ」の節。
    ログは 1 行ごとに収集基盤へ流れるのでインスタンスの数に依存しない）。この経路の
    `agentops_http_responses_total` は「いま応答しているインスタンスが生きているか」の
    健康確認として読む。
  - 常駐のプロセス（1 台／固定台数のコンテナ）へ配備するなら、引きに行く形がそのまま成り立つ。
  - 押す形（スクレイプを待たずに送る）は入れていない。理由と代替案は ADR-0014 の宿題。
- **数えるのは `route()` を通る経路だけではない。** 未認証の受信 Webhook・`GET /health`・
  画面側の CSV・`/metrics` 自身も同じ系列に乗る（**この系列が「どの経路の応答か」は分からない** —
  ラベルは method と status だけなので、受信 Webhook の 401 と期限切れユーザートークンの 401 は
  見分けが付かない）。
  - **だから「署名鍵の設定ミス」「収集側の設定ミス」はログの `event` で見る**:
    `billing.signature_rejected` / `metrics.token_rejected`。`{status="401"}` の増加は
    「何かが 401 を積んでいる」までしか言わない。
  - **「断った」記録と「設定が使えない」記録は間引いてある**（1 要求 1 行だと匿名の相手が
    ログの量＝保存の費用を好きなだけ増やせる）。対象は、断った側が
    `billing.signature_rejected` / `metrics.token_rejected` / `session.login_rejected` /
    `session.cross_origin_action` / `health.db_unreachable`、設定が使えない側が `audit.secret_not_configured` /
    `audit.secret_too_short` / `auth.platform_token_not_configured` /
    `auth.platform_token_too_short` /
    `billing.secret_not_configured` / `billing.secret_too_short` /
    `metrics.token_not_configured` / `metrics.token_too_short` / `plan.unknown_plan` /
    `rate_limit.contended` / `rate_limit.store_unavailable`
    （**一覧の正本は `src/` 全体で `logEventThrottled` を呼んでいる箇所**で、
    `tests/docs-gate.test.ts` がそこから導いてこの一覧と突き合わせる — 足しても消しても
    ここが古いままなら落ちる。件数とファイル名は書かない）。
    - **`auth.platform_token_not_configured` は「どの資格情報としても読めない値が来たとき」
      にだけ出る。** あの照合は成功する要求もすべて通るので、読んだ場所で出すと
      `PLATFORM_ADMIN_TOKEN` を使わない配備が毎要求 1 件を数え、警報が鳴り続ける。
      設定漏れのまま最初の手順（`POST /api/v1/tenants`）を叩けば必ず鳴る。
    - **「未設定」と「短すぎる」は別の出来事にしてある。** 直し方が違う（変数を足すのか、
      値を作り直すのか）ので、同じ `event` だとログからも
      `agentops_log_events_total` からも区別できない。
    - **設定が使えない側も 1 度きりにはしない。** 鍵やトークンの設定漏れは直すまで続き、
      続いていること自体が運用者の知りたいこと（たとえば `STRIPE_WEBHOOK_SECRET` の
      設定漏れは受信 Webhook を全滅させ、事業者はバックオフののちエンドポイントを無効化する
      ので、解約が反映されず有料の権限が残る）。1 度きりだと、その 1 行を取りこぼした配備では
      以降どの出口にも何も現れず、`agentops_log_events_total` も 1 で止まる。
    - **1 プロセスに 1 度だけ出すのは、率を別の出口から読める出来事に限る。** いま該当するのは
      入口が返す読めないパスの 404（`entry.undecodable_path`）で、その率は**前段のアクセス
      ログが 1 件ずつ持っている**。
  - **間引きは「窓あたり 1 本」ではなく、窓の中の通算件数が 2 の冪のときだけ行にする**
    （1 / 2 / 4 / 8 / … 件目）。行には**その時点の通算件数**が `occurrence` として載る。
    だから**警報は「行が出たこと」で組み、規模は最後に出た行の `occurrence` で読む**。
    - 窓あたり 1 本にして「次の行に間引いた件数を載せる」形は使えない。**止まった総当たり**
      （1 万件叩いて去る）では次の行が永遠に来ないので、記録は 1 件目の 1 行だけになる。
    - 2 の冪なら行数は件数の対数で収まり（1 万件でも 14 行）、**最後の行を見れば桁が分かる**。
      行数そのものをしきい値にしないこと（対数なので「毎分 1 件」と「毎分 1 万件」で
      行数は 1 対 14 しか違わない）。
    - `agentops_log_events_total{event="…"}` には**毎回**積まれる。ただし**画面側
      （Server Action）の出来事はその系列が `/metrics` から読めない**（上記の実体の違い）ので、
      そこでは `occurrence` が唯一の規模の手掛かり。
- **ただし `agentops_http_responses_total` は「アプリが返す HTTP 応答のすべて」ではない。**
  乗るのは Route Handler（`src/app/**/route.ts`）の応答だけで、**数えない種類が別にある**
  （正本は `src/lib/uncounted-response-sources.ts` の `UNCOUNTED_RESPONSE_SOURCES`。下の箇条書きはそこから
  導いた写しで、`tests/docs-gate.test.ts` が両向きに突き合わせる）。この系列だけを見て
  「他の通信はすべて覆われている」と読まないこと。
  - **スクレイプ自身もこの系列に乗る。** `/metrics` も包むラッパーを通るので、1 回の収集が
    `{method="GET",status="200"}` を 1 つ積む（実測）。系列に経路のラベルは無いので、
    **PromQL で除くことはできない**。15 秒間隔なら 1 時間に 240 件の 200 が分母へ入るので、
    **率（`rate(…{status=~"5.."}[5m]) / rate(…[5m])`）はこの配備では当てにならない** —
    とくに本来の流量が少ない配備では、全要求が 500 でも率が数％に見える。**警報は率ではなく
    5xx の絶対数**（`rate(…{status=~"5.."}[5m])`）で組むこと。401 / 503 を数えているのは
    収集側の設定ミスを見つけるためで、そこは有用（上記のログの `event` と併せて読む）。
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
    `session.login_rejected` で警報にする（別オリジンからの送信は
    `session.cross_origin_action`）。**行は間引いてあるので、行数ではなく行の
    `occurrence`（窓の中の通算件数）で規模を読む** — 行数は件数の対数なので、打ち間違いの
    1 件と総当たりの 1 万件で 1 対 14 しか違わない（上の「間引き」の項）。**条件はログの `event` で組むこと** —
    `agentops_http_responses_total` にも `agentops_log_events_total` にも現れない
    （下の「ログの出来事の数は Route Handler の束の分だけ」を参照）。
  - Next.js がルートの代わりに組み立てる応答。<!--uncounted:frameworkSynthesized-->
    export の無いメソッドへの **405** と、自動実装される **`OPTIONS`** の 204。
    本番ビルドで実測（3 件とも系列に現れない）。**メソッド総当たりの 405 の急増は
    この系列では見えない**ので、前段のアクセスログで見る（405 は本文が無く `OPTIONS` は
    `allow` だけなので、テナント固有の内容は漏れない）。
  - Route Handler から投げた Next.js の制御フローの例外。<!--uncounted:nextControlFlow-->
    `redirect()` / `notFound()` などは応答を Next.js が組み立てるので、アプリ側に数える場所が
    無い（包むラッパーはこれを 500 へ写さず投げ直す。写すと遷移も 404 も起きない）。
    **数えられないだけでなく `Cache-Control: no-store` も `Vary` も付かない**（押印も
    ラッパーの中なので投げ直した時点で通らない）。遷移先は共通のログイン画面でテナント固有の
    内容を持たないが、**認証付きの経路から投げるようになったら前段のキャッシュ設定を見直す**。
    **いま投げている経路は 1 本も無い**が、画面側のルートを `requireSession()` へ寄せると
    生まれる。前段のアクセスログで見る。
- **`agentops_log_events_total` は Route Handler の束が実行した分だけ。** Next.js はアプリを
  複数の束へ分けて配るので、カウンタの状態も束ごとに別の実体になる（本番ビルドで確認した束は
  3 つ: Route Handler ／ 画面の描画と Server Action ／ 入口）。`/metrics` が読むのは
  Route Handler の実体なので、**Server Action や入口からしか出ない出来事は系列に現れず**
  （`session.login_rejected` / `session.cross_origin_action` / `entry.undecodable_path`）、
  両方の層から出る出来事（`plan.unknown_plan`）は一部しか数えられない。
  **`event` の警報はログの行で組むこと。** メトリクスの系列を条件にすると一度も発火しない。
- **耐久する事実はここに出さない。** 利用量・コストは `GET /api/v1/usage/daily`、
  インシデントは画面と `GET /api/v1/incidents`、操作の記録は `GET /api/v1/audit-logs`。
