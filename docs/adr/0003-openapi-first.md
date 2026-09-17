# ADR-0003: API は OpenAPI 定義を正本にし、型を生成して実装する

- **ステータス**: 採択
- **日付**: 2026-09-16

## 背景

Step1 以降で REST API を実装し、Step7 で API docs を公開する。実装から後追いで文書を書くと、文書と実装がずれたまま出荷される。Step0 の受け入れ基準に「OpenAPI 定義が存在し `npm run gen` で型生成が通る」がある。

## 決定

- `openapi/openapi.yaml`（OpenAPI 3.1）を **API 契約の正本**にする。
- `npm run gen` が `openapi-typescript` で `src/generated/openapi.d.ts` を生成し、`src/lib/api-types.ts` がアプリ側の名前で再公開する。Route Handler の応答型・リクエスト型はここから取る。
- 定義の健全性（operationId の一意性・タグの宣言・書き込み系の 403 宣言）は `tests/openapi.test.ts` が固定する。
- 実装が契約に従うことは Step1 の API テスト（応答をスキーマで検証）で確かめる。

## 理由

- 型生成により、定義を変えると実装側の `typecheck` が赤くなる。文書と実装の乖離を機械的に検出できる。
- `openapi-typescript` は実行時依存を増やさず（型のみ）、Next.js のバンドルにも影響しない。

## 結果

- 新しいエンドポイントは「OpenAPI 定義 → `npm run gen` → 実装 → API テスト」の順で作る。
- ページネーション（`limit` 最大 200・`cursor`）とエラー形式（`{ status, message, issues? }`）は定義側で統一し、実装ごとに発明しない。
