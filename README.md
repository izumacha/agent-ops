# Agent Ops

AI エージェントの**登録・権限・コスト・品質・停止**を一元管理する運用基盤（SaaS）。複数のエージェントを複数チームで運用し、コストと品質を可視化して事故（暴走・コスト超過・品質低下）を自動で止める。

- スタック: Next.js 16（App Router）/ TypeScript / Prisma 7 / PostgreSQL 16 / Docker
- 現在の段階: **Step1（エージェント台帳・権限）実装済み**。ロードマップは [`docs/roadmap.md`](./docs/roadmap.md)、仕様は [`docs/spec.md`](./docs/spec.md)

## デモ

ダッシュボード（Step5）実装後に、`docs/screenshots/` へ主要 5 画面のスクリーンショットと「登録 → 実行 → 超過 → 停止 → 復帰」のデモ GIF を置く。公開デモ URL は Step7（Vercel/Supabase 向けデプロイ設定）で用意する。

## セットアップ

必要環境: Node.js 22（`.nvmrc`）・npm 10・Docker（PostgreSQL 用）。

```bash
cp .env.example .env               # DATABASE_URL と PLATFORM_ADMIN_TOKEN (32 文字以上の乱数) を設定
docker compose up -d db            # PostgreSQL 16 を起動
npm ci                             # 依存インストール
npm run gen                        # OpenAPI → TypeScript 型を生成 (src/generated/openapi.d.ts)
npm run db:generate                # Prisma クライアントを生成 (src/generated/prisma)
npm run db:migrate                 # マイグレーション適用 (prisma migrate dev)
npm run db:seed                    # デモ用テナント / ユーザー / エージェントを投入
npm run dev                        # http://localhost:3000
```

アプリごと Docker で動かす場合: `docker compose up --build`（`app` サービスが起動時に `prisma migrate deploy` を実行する）。生存確認は `GET /api/v1/health`（DB 到達性を含む）。

### API を叩く（Step1）

認証は Bearer トークン（[ADR-0005](./docs/adr/0005-bearer-token-auth.md)）。seed 済みのユーザーには CLI でログイントークンを発行する（平文は 1 度だけ表示される）。

```bash
npx tsx scripts/issue-user-token.ts --email admin@example.com   # default-tenant の管理者にトークン発行
export TOKEN=aop_u_...                                          # 表示された平文
curl -s -H "Authorization: Bearer $TOKEN" localhost:3000/api/v1/me
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"要約ボット","provider":"anthropic","model":"claude-sonnet-4-6"}' localhost:3000/api/v1/agents
```

新しいテナントは `PLATFORM_ADMIN_TOKEN` で `POST /api/v1/tenants` を呼ぶと、テナント・最初の admin・その admin のトークンがまとめて返る。エンドポイント一覧は [`docs/spec.md` §4](./docs/spec.md#4-api-一覧)、定義は [`openapi/openapi.yaml`](./openapi/openapi.yaml)。

## 検証コマンド

```bash
npm run lint         # ESLint 9 (flat config + next/core-web-vitals)
npm run typecheck    # tsc --noEmit
npm run test         # Vitest (tests/**/*.test.ts。API テストは memory アダプタで DB 不要)
npm run test:contract # prisma アダプタの契約テスト (RUN_PRISMA_CONTRACT=1 + 専用 DB の DATABASE_URL が必要。全テーブルを TRUNCATE する)
npm run build        # 本番ビルド (standalone 出力)
npm run gate:step0   # Step0 の受け入れ基準を一括検査 (gen / db:generate / lint / typecheck / test / OpenAPI / ADR)
npm run gate:step1   # Step1 の受け入れ基準を一括検査 (上記 + テスト 60 件以上 / RBAC 3×3 の 403 / npm audit high 0)
```

CI（`.github/workflows/ci.yml`）は `gate:step1` に加え、PostgreSQL サービスコンテナへのマイグレーション適用・seed の冪等性・prisma アダプタの契約テスト・本番ビルド・Docker 起動を検証する。

## ディレクトリ

| パス | 内容 |
|---|---|
| `docs/spec.md` | 仕様書（正本）: ユースケース 10 件・ER 図・API 一覧 |
| `docs/roadmap.md` | 8 Step のロードマップと受け入れ基準（`gate:stepN`） |
| `docs/adr/` | 設計判断の記録（ADR） |
| `openapi/openapi.yaml` | REST API 定義（OpenAPI 3.1、契約の正本） |
| `prisma/schema.prisma` | DB スキーマ（全テーブルに `tenantId`） |
| `src/domain/` | フレームワーク非依存の純粋ロジック（RBAC 許可表・金額） |
| `src/data/` | Ports & Adapters（`ports/` 契約、`adapters/prisma/` 本番、`adapters/memory/` テスト） |
| `src/lib/` | 横断インフラ（Prisma 結線・定数・トークン・API 基盤 `api/`・Zod スキーマ `validations/`） |
| `src/app/api/v1/` | Route Handlers（OpenAPI 定義と 1:1） |
| `scripts/gate-stepN.mjs` | Step ごとのゲート（`scripts/issue-user-token.ts` は開発用トークン発行 CLI） |
| `tests/` | ユニット・API テスト（`tests/api/`）と契約テスト（`tests/data/*.contract.prisma.test.ts`） |

## ロードマップ（要約）

| Step | 内容 | 期間 |
|---|---|---|
| 0 | 設計・骨組み（実装済み） | 1 週 |
| 1 | エージェント台帳・権限（CRUD / API キー / RBAC。実装済み・本 README の状態） | 2 週 |
| 2 | コスト計測プロキシ（Anthropic/OpenAI 互換） | 2 週 |
| 3 | 品質評価（LLM-as-judge） | 2 週 |
| 4 | ガードレール・自動停止・通知・監査ログ | 2 週 |
| 5 | ダッシュボード | 2 週 |
| 6 | マルチテナント・課金（Stripe） | 2 週 |
| 7 | リリース準備 | 1 週 |

各 Step の受け入れ基準は `npm run gate:stepN` で機械的に検査し、赤なら次 Step のブランチを切らない。

## ライセンス

MIT
