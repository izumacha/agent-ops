# Agent Ops — 仕様書（Step1 時点）

> このファイルはプロダクトの**正本（Source of Truth）**。ユースケース・ER 図・API 一覧を持ち、
> 実装（`prisma/schema.prisma` / `openapi/openapi.yaml`）と衝突したら**先にこの文書を改訂してから**実装を変える。
> ロードマップと各 Step の受け入れ基準は [`roadmap.md`](./roadmap.md)、設計判断は [`adr/`](./adr/) を参照。

## 1. 目的と範囲

Agent Ops は、社内外で稼働する AI エージェントを**登録・権限管理・コスト計測・品質評価・自動停止**の 5 つの観点で一元管理する SaaS。対象は「複数のエージェントを複数チームで運用し、コストと品質を可視化して事故（暴走・コスト超過・品質低下）を止めたい」組織。

- **含む**: エージェント台帳、RBAC、LLM 呼び出しのプロキシ経由コスト計測、LLM-as-judge による品質評価、しきい値ルールによる自動停止・通知、監査ログ、ダッシュボード、マルチテナント、課金。
- **含まない**: エージェント自体の開発フレームワーク、人手の営業・ヒアリング、オンプレ配備。

## 2. ユースケース（10 件）

役割は `viewer`（閲覧）/ `operator`（閲覧＋実行）/ `admin`（閲覧＋実行＋停止）の 3 つ（RBAC の正本は `src/domain/rbac.ts`）。

### UC-01 テナントを作成する（Step1）

- 主体: プラットフォーム管理者（テナントの外側。§4 の権限語彙を参照。環境変数 `PLATFORM_ADMIN_TOKEN` で認証。ADR-0005）
- 事前条件: なし
- 流れ: 名前と最初の `admin` のメール・表示名を指定してテナントを作成 → テナント・`admin` ユーザー・その admin のログイントークンが 1 トランザクションで作られ、トークンの平文は作成応答でのみ返る
- 事後条件: 以後の全データはこのテナントに紐づき、他テナントからは見えない

### UC-02 ユーザーを招待し役割を付与する（Step1）

- 主体: `admin`
- 流れ: メール・表示名・役割を指定して招待 → 役割は後から変更可能 → ログイントークンは `admin` が発行・失効する（既定 90 日・最長 365 日）
- 例外: `admin` 以外が呼ぶと 403。最後の有効な `admin` の降格・無効化、自分自身の無効化、無効化済みユーザーへのトークン発行は 409。メールは小文字に正規化して保存し、テナント内の一意性は大文字小文字を区別しない
- 補足: ユーザーは削除せず無効化する（`disabledAt`）。無効化されたユーザーのトークンは 401 になる

### UC-03 エージェントを登録する（Step1）

- 主体: `operator` 以上
- 流れ: 名前・プロバイダ・モデル・（任意）月次予算を登録
- 例外: 同一テナント内で名前が重複すると 422

### UC-04 API キーを発行・失効する（Step1）

- 主体: 発行は `operator` 以上、失効は `admin`
- 流れ: 用途名を付けて発行 → 平文は発行応答でのみ返す → 以後はハッシュのみ保持
- 事後条件: 失効したキーでのプロキシ呼び出しは 401

### UC-05 プロキシ経由で LLM を呼び出しコストを記録する（Step2）

- 主体: エージェント（API キーで認証）
- 流れ: Anthropic/OpenAI 互換のエンドポイントへ送信 → 上流へ中継 → トークン数・料金・遅延を `UsageEvent` に記録
- 基準: 追加遅延 p95 ≦ 50ms、料金計算はベンダー公表単価と誤差 0

### UC-06 コストを日次で集計して閲覧する（Step2 / Step5）

- 主体: `viewer` 以上
- 流れ: テナント・エージェント・日付で `UsageEvent` を集計 → ダッシュボードに表示
- 基準: 1 万件投入で集計 SQL ≦ 1 秒

### UC-07 エージェントの応答品質を評価する（Step3）

- 主体: `operator` 以上
- 流れ: 評価セット（固定入力 100 件）を選び実行 → LLM-as-judge が正確性・安全性・逸脱を採点 → 過去の実行と回帰比較
- 基準: 同一入力での採点一致率 ≧ 90%、幻覚 ID 等の不正出力は除外

### UC-08 しきい値ルールを設定し自動停止させる（Step4）

- 主体: 設定は `admin`、発火はシステム
- 流れ: コスト超過・品質低下・エラー率のルールを設定 → 集計窓で監視 → 超過したらインシデントを記録し、`stop` なら `suspended` へ → Webhook/メールで通知
- 基準: 発火から停止まで ≦ 3 秒

### UC-09 停止したエージェントを復帰させる（Step4）

- 主体: `admin`
- 流れ: インシデントを確認 → 原因対処 → `resume` で `active` へ戻す → インシデントを `resolved` に
- 事後条件: 監査ログに操作者・時刻・対象が残る（改ざん検知付き）

### UC-10 プランを契約し機能ゲートを解除する（Step6）

- 主体: `admin`
- 流れ: Stripe Checkout で Free → Pro/Enterprise に変更 → Webhook でプランを更新 → 機能ゲート（エージェント数・評価回数・レート制限）が緩和
- 基準: Webhook は冪等、テナント越境アクセスは全パターン拒否

## 3. ER 図

`prisma/schema.prisma` と同期させる（列の詳細・インデックスはスキーマ側が正本）。テナントに属する資源はすべて `tenantId` を持ち、クエリは必ずテナントで絞る（ADR-0002）。例外は親経由でしか到達しない子テーブル（`EvaluationCase` は `EvaluationSet` 経由）で、親を `tenantId` で絞ってから辿る。`setId` だけで直接引かない。

```mermaid
erDiagram
  Tenant ||--o{ User : has
  Tenant ||--o{ UserToken : has
  User ||--o{ UserToken : "logs in with"
  Tenant ||--o{ Agent : has
  Tenant ||--o{ ApiKey : has
  Tenant ||--o{ UsageEvent : has
  Tenant ||--o{ EvaluationSet : has
  Tenant ||--o{ EvaluationRun : has
  Tenant ||--o{ GuardrailRule : has
  Tenant ||--o{ Incident : has
  Tenant ||--o{ AuditLog : has
  Agent ||--o{ ApiKey : "authenticates"
  Agent ||--o{ UsageEvent : "produces"
  Agent ||--o{ EvaluationRun : "evaluated by"
  Agent ||--o{ GuardrailRule : "guarded by"
  Agent ||--o{ Incident : "raises"
  EvaluationSet ||--o{ EvaluationCase : contains
  EvaluationSet ||--o{ EvaluationRun : "used in"
  GuardrailRule ||--o{ Incident : triggers
  User ||--o{ AuditLog : acts

  Tenant {
    string id PK
    string name
    Plan plan
  }
  User {
    string id PK
    string tenantId FK
    string email
    Role role
    datetime disabledAt
  }
  UserToken {
    string id PK
    string tenantId FK
    string userId FK
    string prefix
    string tokenHash
    datetime expiresAt
    datetime revokedAt
  }
  Agent {
    string id PK
    string tenantId FK
    string name
    Provider provider
    string model
    AgentStatus status
    bigint budgetMicroUsd
  }
  ApiKey {
    string id PK
    string tenantId FK
    string agentId FK
    string prefix
    string keyHash
    datetime revokedAt
  }
  UsageEvent {
    string id PK
    string tenantId FK
    string agentId FK
    int inputTokens
    int outputTokens
    bigint costMicroUsd
    int latencyMs
  }
  EvaluationSet {
    string id PK
    string tenantId FK
    string name
  }
  EvaluationCase {
    string id PK
    string setId FK
    string input
    string expected
  }
  EvaluationRun {
    string id PK
    string tenantId FK
    string agentId FK
    string setId FK
    float accuracy
    float safety
    float deviation
  }
  GuardrailRule {
    string id PK
    string tenantId FK
    string agentId FK
    RuleKind kind
    float threshold
    int windowMinutes
    RuleAction action
  }
  Incident {
    string id PK
    string tenantId FK
    string agentId FK
    string ruleId FK
    IncidentStatus status
  }
  AuditLog {
    string id PK
    string tenantId FK
    string actorId FK
    string action
    string targetType
    string targetId
  }
```

金額は浮動小数誤差を避けるため**マイクロ USD の整数（BigInt）**で持つ（1 USD = 1,000,000）。JSON では文字列で運ぶ（最大 19 桁）。

### 削除の規則（参照整合性）

- **履歴（`UsageEvent` / `EvaluationRun` / `Incident`）は親の削除で消さない（`Restrict`）。** コスト履歴は請求の根拠、インシデントは停止理由の記録なので、履歴を持つエージェントは削除できず `stop` で止める（`DELETE /agents/{id}` は 409）。実行履歴を持つ評価セット、発火済みのルールも同様（ルールは `enabled=false` で無効化）。
- **設定（`ApiKey` / `GuardrailRule`）はエージェントと一緒に消える（`Cascade`）。** `ApiKey.agentId` を `SetNull` にすると削除で「テナント共通キー」へ黙って昇格し権限が広がるため、Cascade にする。
- **監査ログの操作者（`AuditLog.actorId`）は `Restrict`。** 監査ログを持つユーザーは削除せず無効化する（`User.disabledAt`。`DELETE /users/{userId}` は無効化）。ユーザーのログイントークン（`UserToken`）は設定なので `Cascade`。テナント解約は `Cascade` でデータ一式を消す（テナント単位の消去要求に応えるため）。
- **子テーブルは複合 FK `(tenantId, 親id)` で親を参照する。** 「別テナントのエージェント／セット／ルール／ユーザーを指す行」をクエリ規律だけでなく DB 制約でも拒否する（`Agent` / `EvaluationSet` / `GuardrailRule` / `User` に `@@unique([tenantId, id])`）。

## 4. API 一覧

定義の正本は [`openapi/openapi.yaml`](../openapi/openapi.yaml)（`npm run gen` で型を生成）。ベースパスは `/api/v1`、認証は Bearer（ユーザートークン `aop_u_...`、またはテナント作成・列挙専用のプラットフォーム管理者トークン。ADR-0005）。他テナントの資源は存在を隠すため 404 を返す。一覧は `limit`（既定 50・最大 200）と `cursor`（前応答の `nextCursor`。最終行の位置を符号化した不透明な値で、その行が削除されても続きが取れる）でページ送りする。

「必要権限」列の語彙は 3 種類で、混ぜない。

- **`view` / `execute` / `stop`** — テナント内 RBAC の操作。`src/domain/rbac.ts` の許可表 `PERMISSIONS`（役割 3 × 操作 3）が唯一の真実の源。
- **`admin` ロール限定** — ユーザー招待・役割変更のような「役割そのものを扱う」操作。3 操作の表とは別軸で、実装は「役割が `admin` であること」を明示的に確かめる（`role === 'admin'` を許す唯一の用途）。Step1 の 403 テスト（役割 3 × 操作 3）に加えて、`viewer` / `operator` がこれらを呼ぶと 403 になることも固定する。
- **プラットフォーム管理者** — テナントを作る・列挙する操作。テナントの外側にいるため RBAC の表では表現しない。環境変数 `PLATFORM_ADMIN_TOKEN` と一致する Bearer トークンで認証し、テナント内の資源には閲覧も含めて触れない（403。ADR-0005）。

| メソッド | パス                       | operationId      | 必要権限       | Step |
| -------- | -------------------------- | ---------------- | -------------- | ---- |
| GET      | `/health`                  | `getHealth`      | なし           | 0    |
| GET      | `/tenants`                 | `listTenants`    | プラットフォーム管理者 | 1    |
| POST     | `/tenants`                 | `createTenant`   | プラットフォーム管理者 | 1    |
| GET      | `/tenants/{tenantId}`      | `getTenant`      | view           | 1    |
| GET      | `/me`                      | `getMe`          | テナントのユーザー（役割不問） | 1    |
| GET      | `/users`                   | `listUsers`      | view           | 1    |
| POST     | `/users`                   | `createUser`     | `admin` ロール限定          | 1    |
| DELETE   | `/users/{userId}`          | `disableUser`    | `admin` ロール限定          | 1    |
| PUT      | `/users/{userId}/role`     | `updateUserRole` | `admin` ロール限定          | 1    |
| GET      | `/users/{userId}/tokens`   | `listUserTokens` | `admin` ロール限定          | 1    |
| POST     | `/users/{userId}/tokens`   | `createUserToken` | `admin` ロール限定         | 1    |
| DELETE   | `/users/{userId}/tokens/{tokenId}` | `revokeUserToken` | `admin` ロール限定 | 1    |
| GET      | `/agents`                  | `listAgents`     | view           | 1    |
| POST     | `/agents`                  | `createAgent`    | execute        | 1    |
| GET      | `/agents/{agentId}`        | `getAgent`       | view           | 1    |
| PATCH    | `/agents/{agentId}`        | `updateAgent`    | execute        | 1    |
| DELETE   | `/agents/{agentId}`        | `deleteAgent`    | stop           | 1    |
| POST     | `/agents/{agentId}/stop`   | `stopAgent`      | stop           | 1    |
| POST     | `/agents/{agentId}/resume` | `resumeAgent`    | stop           | 1    |
| GET      | `/api-keys`                | `listApiKeys`    | view           | 1    |
| POST     | `/api-keys`                | `createApiKey`   | execute        | 1    |
| DELETE   | `/api-keys/{apiKeyId}`     | `revokeApiKey`   | stop           | 1    |

Step2 以降（プロキシ `/proxy/*`、集計 `/usage/daily`、評価 `/evaluations`、ルール `/guardrails`、インシデント `/incidents`、課金 `/billing`）は各 Step の着手時にこの表と OpenAPI 定義へ追加する。

## 5. 非機能要件（抜粋）

- **セキュリティ**: 全 Server Action / Route Handler で認証・RBAC・`tenantId` の絞り込みを強制（CLAUDE.md §9）。API キー・ユーザートークンはハッシュのみ保存。JSON 本文は 64 KiB まで（413）、`Content-Type` は `application/json` 限定（415）。監査ログは追記専用。
- **性能**: 一覧は必ず上限（既定 50、最大 200）。プロキシの追加遅延 p95 ≦ 50ms。
- **可観測性**: `/api/v1/health` で DB 到達性を返す。エラーは内部詳細を出さずサーバログへ。
- **移植性**: PostgreSQL 16 / Node 22 / Docker。ローカルと CI で検証が完結する（人手の外部手順に依存しない）。
