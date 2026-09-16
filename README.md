# Agent Ops

AI エージェントの**登録・権限・コスト・品質・停止**を一元管理する運用基盤（SaaS）。複数のエージェントを複数チームで運用し、コストと品質を可視化して事故（暴走・コスト超過・品質低下）を自動で止める。

- スタック: Next.js 16（App Router）/ TypeScript / Prisma 7 / PostgreSQL 16 / Docker
- 現在の段階: **Step0（設計・骨組み）**。ロードマップは [`docs/roadmap.md`](./docs/roadmap.md)、仕様は [`docs/spec.md`](./docs/spec.md)

## デモ

ダッシュボード（Step5）実装後に、`docs/screenshots/` へ主要 5 画面のスクリーンショットと「登録 → 実行 → 超過 → 停止 → 復帰」のデモ GIF を置く。公開デモ URL は Step7（Vercel/Supabase 向けデプロイ設定）で用意する。

## セットアップ

必要環境: Node.js 22（`.nvmrc`）・npm 10・Docker（PostgreSQL 用）。

```bash
cp .env.example .env               # DATABASE_URL を設定
docker compose up -d db            # PostgreSQL 16 を起動
npm ci                             # 依存インストール
npm run gen                        # OpenAPI → TypeScript 型を生成 (src/generated/openapi.d.ts)
npm run db:generate                # Prisma クライアントを生成 (src/generated/prisma)
npm run db:migrate                 # マイグレーション適用 (prisma migrate dev)
npm run db:seed                    # デモ用テナント / ユーザー / エージェントを投入
npm run dev                        # http://localhost:3000
```

アプリごと Docker で動かす場合: `docker compose up --build`（`app` サービスが起動時に `prisma migrate deploy` を実行する）。生存確認は `GET /api/v1/health`（DB 到達性を含む）。

## 検証コマンド

```bash
npm run lint         # ESLint 9 (flat config + next/core-web-vitals)
npm run typecheck    # tsc --noEmit
npm run test         # Vitest (tests/**/*.test.ts)
npm run build        # 本番ビルド (standalone 出力)
npm run gate:step0   # Step0 の受け入れ基準を一括検査 (gen / db:generate / lint / typecheck / test / OpenAPI / ADR)
```

CI（`.github/workflows/ci.yml`）は `gate:step0` に加え、PostgreSQL サービスコンテナへのマイグレーション適用・seed の冪等性・本番ビルドを検証する。

## ディレクトリ

| パス | 内容 |
|---|---|
| `docs/spec.md` | 仕様書（正本）: ユースケース 10 件・ER 図・API 一覧 |
| `docs/roadmap.md` | 8 Step のロードマップと受け入れ基準（`gate:stepN`） |
| `docs/adr/` | 設計判断の記録（ADR） |
| `openapi/openapi.yaml` | REST API 定義（OpenAPI 3.1、契約の正本） |
| `prisma/schema.prisma` | DB スキーマ（全テーブルに `tenantId`） |
| `src/domain/` | フレームワーク非依存の純粋ロジック（RBAC 許可表など） |
| `src/lib/` | 横断インフラ（Prisma 結線・定数・API 型の再公開） |
| `src/app/` | Next.js App Router（ページ・Route Handlers） |
| `scripts/gate-step0.mjs` | Step0 ゲート |
| `tests/` | ユニットテスト |

## ロードマップ（要約）

| Step | 内容 | 期間 |
|---|---|---|
| 0 | 設計・骨組み（本 README の状態） | 1 週 |
| 1 | エージェント台帳・権限（CRUD / API キー / RBAC） | 2 週 |
| 2 | コスト計測プロキシ（Anthropic/OpenAI 互換） | 2 週 |
| 3 | 品質評価（LLM-as-judge） | 2 週 |
| 4 | ガードレール・自動停止・通知・監査ログ | 2 週 |
| 5 | ダッシュボード | 2 週 |
| 6 | マルチテナント・課金（Stripe） | 2 週 |
| 7 | リリース準備 | 1 週 |

各 Step の受け入れ基準は `npm run gate:stepN` で機械的に検査し、赤なら次 Step のブランチを切らない。

## ライセンス

MIT
