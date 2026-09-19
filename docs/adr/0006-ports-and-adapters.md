# ADR-0006: データ層は Ports & Adapters にし、API テストは memory アダプタで本番と同じ経路を通す

- **ステータス**: 採択
- **日付**: 2026-09-17

## 背景

Step1 の受け入れ基準は「ユニット＋API テスト 60 件以上」「役割 3 × 操作 3 の権限違反で 403」で、認証・認可・入力検証・テナント境界・ページネーションを **Route Handler の経路そのもの**で検証したい。一方、ユニットテストに DB を持ち込まない（CLAUDE.md §11）ため、Route Handler を Prisma に直結すると API テストが書けない。

## 決定

- **Port**（契約）を `src/data/ports/` に置く。レコード型は Prisma の生成型ではなく Port 側で定義し、Prisma / Next に依存しない。
- **Adapter** は 2 つ: 本番の `src/data/adapters/prisma/`（Prisma を直接 import してよい唯一のディレクトリ。ESLint の例外に登録）と、テスト用の `src/data/adapters/memory/`（インメモリの表）。
- **Composition Root** は `src/data/index.ts` の `getRepos()`。Route Handler はこれだけを呼ぶ。テストは `setReposForTesting()` で memory アダプタへ差し替える（本番 `NODE_ENV=production` では呼べない）。
- 2 つのアダプタが**同じ契約**を満たすことは、memory 側を API テスト（`tests/api/*.test.ts`）が、prisma 側を契約テスト（`tests/data/*.contract.prisma.test.ts`、`RUN_PRISMA_CONTRACT=1` のときだけ・専用 DB）が固定する。
- データ層の失敗はデータ層の型（`DuplicateError`）に翻訳し、Prisma の例外型を API 層へ持ち出さない。削除の可否は戻り値（`'deleted' | 'not_found' | 'restricted'`）で表す。

## 理由

- API テストが本番と同じ認証・認可・検証コードを通るので、「テストではモックが 403 を返した」型の空振りが起きない。
- Prisma の import を 1 ディレクトリに閉じることで、`npm run db:generate` 無しでも API テストが動く。
- 契約テストを分けることで、複合 FK・Restrict・一意制約のような DB でしか確かめられない挙動を捨てずに済む。

## 結果

- 新しいエンティティ操作は「Port → memory アダプタ → prisma アダプタ → API テスト → 契約テスト」の順で足す。片方のアダプタだけに実装すると型エラーになる（`Repositories` の型が両方に同じ契約を要求する）。
- Step2 のプロキシ（`UsageEvent` の記録・API キー照合）も同じ形で Port を増やす。
