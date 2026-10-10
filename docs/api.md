# API リファレンス

**契約の正本は `openapi/openapi.yaml`（OpenAPI 3.1）で、このファイルはその読み物版。**
エンドポイントを足すときの順序は「定義 → `npm run gen` → 実装 → API テスト」（ADR-0003）なので、
**ここを先に書いても契約は増えない**。逆に契約へ足してここへ書き忘れると
`tests/api-docs.test.ts` が落ちる（下の「この文書の鮮度」）。

## 基本

| 項目 | 値 |
| ---- | -- |
| 基底パス | `/api/v1`（`openapi.yaml` の `servers.url`） |
| 認証 | `Authorization: Bearer <トークン>`（4 系統 ＋ 署名付き Webhook。下記） |
| 形式 | リクエスト・レスポンスともに `application/json`（**例外は `GET /metrics` の 200 だけ** — Prometheus のテキスト形式 `text/plain; version=0.0.4`。`openapi.yaml` の宣言が正本） |
| 金額 | マイクロ USD の整数を**文字列**で運ぶ（1 USD = 1,000,000。浮動小数誤差を避ける） |
| 一覧 | `limit` と `cursor` のキーセットページング（`createdAt → id` 順） |
| エラー | `{ "error": { "message": ..., "issues"?: ... } }`。文言は日本語 |

### 認証の 4 系統

1. **ユーザートークン**（`aop_u_…`）— 人の操作。テナント内の資源すべてに使う。
   役割は `viewer` / `operator` / `admin`、操作は `view` / `execute` / `stop`（許可表は
   `src/domain/rbac.ts` が唯一の真実の源）。
2. **API キー**（`aop_k_…`）— **中継 2 本だけ**に使う。ユーザー向け API では 401
   （系統を混ぜない。ADR-0005）。
3. **プラットフォーム管理者トークン**（環境変数 `PLATFORM_ADMIN_TOKEN`）—
   `GET/POST /tenants` と `PATCH /tenants/{tenantId}` 専用。テナント内の資源には閲覧も含め 403。
4. **監視用トークン**（環境変数 `METRICS_TOKEN`）— **`GET /metrics` だけ**に使う読み取り専用。
   テナントも役割も持たないので RBAC の対象外で、合わなければ 403 ではなく 401。
   **3 のトークンでは読めない**（あちらはテナント作成 — 応答に新しいテナントの admin トークンの
   平文が載る — とプラン変更も通るので、監視の収集エージェントへ配らない。§9 最小権限）。
   未設定・短すぎは 503（fail-closed）。

**`POST /billing/webhook` だけは Bearer 認証を使わない** — 呼ぶのは事業者（Stripe）なので、
`Stripe-Signature` の HMAC-SHA256 を共有シークレット（`STRIPE_WEBHOOK_SECRET`）で検証する。

### 主なステータス

| コード | 使うとき |
| ------ | -------- |
| 400 / 422 | JSON として読めない / スキーマ検証に落ちた（`issues` に詳細） |
| 401 | トークンが無い・無効・失効・期限切れ・ユーザー無効化（**理由は区別しない**） |
| 403 | 役割に権限が無い／プランで閉じている機能／予算超過 |
| 404 | 存在しない、**または他テナントの資源**（403 だと存在が漏れる。ADR-0002） |
| 409 | いまは実行できない（最後の admin の降格・履歴のある資源の削除・プランの上限） |
| 413 | リクエスト本文が上限を超えた |
| 429 | レート制限（`Retry-After` 付き）。上限は契約プラン別 |
| 502 / 504 | 上流 LLM の失敗・時間切れ（**上流のステータスはそのままにしない**。ADR-0007） |
| 503 | 設定が足りない（署名鍵・監査ログの鍵など。fail-closed） |

## エンドポイント一覧

**表の行は `openapi/openapi.yaml` と 1 対 1**（増減はテストが両向きに突き合わせる）。

| メソッドとパス | operationId | タグ |
| -------------- | ----------- | ---- |
| `GET /health` | `getHealth` | health |
| `GET /metrics` | `getMetrics` | metrics |
| `GET /tenants` | `listTenants` | tenants |
| `POST /tenants` | `createTenant` | tenants |
| `GET /tenants/{tenantId}` | `getTenant` | tenants |
| `PATCH /tenants/{tenantId}` | `updateTenantPlan` | tenants |
| `GET /me` | `getMe` | users |
| `GET /users` | `listUsers` | users |
| `POST /users` | `createUser` | users |
| `DELETE /users/{userId}` | `disableUser` | users |
| `PUT /users/{userId}/role` | `updateUserRole` | users |
| `GET /users/{userId}/tokens` | `listUserTokens` | users |
| `POST /users/{userId}/tokens` | `createUserToken` | users |
| `DELETE /users/{userId}/tokens/{tokenId}` | `revokeUserToken` | users |
| `GET /agents` | `listAgents` | agents |
| `POST /agents` | `createAgent` | agents |
| `GET /agents/{agentId}` | `getAgent` | agents |
| `PATCH /agents/{agentId}` | `updateAgent` | agents |
| `DELETE /agents/{agentId}` | `deleteAgent` | agents |
| `POST /agents/{agentId}/stop` | `stopAgent` | agents |
| `POST /agents/{agentId}/resume` | `resumeAgent` | agents |
| `GET /api-keys` | `listApiKeys` | api-keys |
| `POST /api-keys` | `createApiKey` | api-keys |
| `DELETE /api-keys/{apiKeyId}` | `revokeApiKey` | api-keys |
| `POST /proxy/anthropic/messages` | `proxyAnthropicMessages` | proxy |
| `POST /proxy/openai/chat/completions` | `proxyOpenAiChatCompletions` | proxy |
| `GET /usage/daily` | `getDailyUsage` | usage |
| `GET /evaluation-sets` | `listEvaluationSets` | evaluations |
| `POST /evaluation-sets` | `createEvaluationSet` | evaluations |
| `GET /evaluation-sets/{setId}` | `getEvaluationSet` | evaluations |
| `GET /evaluations` | `listEvaluationRuns` | evaluations |
| `POST /evaluations` | `runEvaluation` | evaluations |
| `GET /evaluations/{runId}` | `getEvaluationRun` | evaluations |
| `GET /guardrails` | `listGuardrailRules` | guardrails |
| `POST /guardrails` | `createGuardrailRule` | guardrails |
| `POST /guardrails/run` | `runGuardrails` | guardrails |
| `PATCH /guardrails/{ruleId}` | `updateGuardrailRule` | guardrails |
| `DELETE /guardrails/{ruleId}` | `deleteGuardrailRule` | guardrails |
| `GET /incidents` | `listIncidents` | incidents |
| `POST /incidents/{incidentId}/resolve` | `resolveIncident` | incidents |
| `GET /audit-logs` | `listAuditLogs` | audit-logs |
| `GET /audit-logs/verify` | `verifyAuditLogs` | audit-logs |
| `GET /billing` | `getBilling` | billing |
| `POST /billing/webhook` | `receiveBillingWebhook` | billing |
| `POST /maintenance/run` | `runMaintenance` | maintenance |

## 最短の手順（quickstart）

実際に動くコマンド列は README の「5 分で試す」が正本（**この文書に写しを置かない** — 片方だけ
古くなる）。概略だけ書くと:

1. `PLATFORM_ADMIN_TOKEN` を設定して起動する。
2. `POST /tenants` でテナントと最初の admin を作る（応答の `adminToken.secret` が平文の
   ログイントークン。**この応答でしか返らない**）。
3. そのトークンで `POST /agents` → `GET /agents`。
4. `POST /api-keys` で中継用のキーを作り、`POST /proxy/anthropic/messages` を叩く。
5. `GET /usage/daily` でコスト、`GET /billing` で上限、`GET /audit-logs` で操作の記録を見る。

## この文書の鮮度

`tests/api-docs.test.ts` が **`openapi/openapi.yaml` から導いて**両向きに突き合わせる:

- 契約にあるオペレーションが、この文書の表に 1 行ずつあること（書き忘れを落とす）。
- この文書の表にあるものが、契約に実在すること（消したエンドポイントの行が残らない）。
- `operationId` も一致すること（パスだけ合わせて別の操作を指す形を落とす）。

**手書きの一覧にしないのが要点** — 一覧をテスト側に持つと、エンドポイントを足した人が
どちらにも足し忘れたときに検査も一緒に縮む（この repo が繰り返し避けている形）。
