# ADR-0001: Next.js 16 + Prisma 7 + PostgreSQL をコアスタックにする

- **ステータス**: 採択
- **日付**: 2026-09-16

## 背景

Agent Ops は管理画面（ダッシュボード）と REST API、LLM 呼び出しを中継するプロキシの 3 つを持つ。検証をローカルと CI で完結させる前提（`docs/roadmap.md`）なので、1 つのリポジトリ・1 つの言語で UI/API/バッチを扱えることが要る。

## 決定

- **Next.js 16（App Router）+ TypeScript strict** を UI と API（Route Handlers / Server Actions）の両方に使う。
- **Prisma 7 + PostgreSQL 16** を永続化に使う。Prisma 7 はドライバアダプタ必須のため、結線は `src/lib/prisma-client.ts` の `createPrismaClient()` に 1 か所で集約し、アプリ・seed・契約テストがすべてこれを経由する。
- 生成物（Prisma クライアント・OpenAPI 型）は `src/generated/` に出力し、コミットしない。
- ローカルは `docker compose up` で DB とアプリを起動する。

## 理由

- 同組織の `helpdesk-hub` / `my-first-ai-app` と同じスタックで、CLAUDE.md の共通規約・CI の型・Prisma 7 の落とし穴（`prisma.config.ts` / `.env` の読み方）の知見をそのまま再利用できる。
- Route Handlers は Anthropic/OpenAI 互換プロキシ（Step2）をストリーミング込みで実装でき、別サーバを増やさなくてよい。
- PostgreSQL は `UsageEvent` の日次集計（Step2 基準: 1 万件で ≦ 1 秒）をインデックスと集計 SQL で満たせる。

## 結果

- Prisma の型/enum は `src/domain/types.ts` からのみ import する（ESLint で強制）。ORM を差し替えるときの影響をそこに閉じ込める。
- プロキシの追加遅延 p95 ≦ 50ms（Step2）は Next.js の Route Handler で計測して確かめる。満たせなければ、プロキシ部分だけを Node の素の HTTP サーバへ切り出す選択肢を ADR で再検討する。
