# docs/ の入口

| ファイル | 内容 |
| --- | --- |
| [`overview.md`](./overview.md) | **全体像の読み物**（図つき 1 枚）。初見ならここから |
| [`spec.md`](./spec.md) | 仕様書（正本）: ユースケース 10 件・ER 図・API 一覧・非機能要件 |
| [`roadmap.md`](./roadmap.md) | 8 Step のロードマップと受け入れ基準（`gate:stepN`） |
| [`adr/`](./adr/) | 設計判断の記録（ADR）。番号順 |
| [`api.md`](./api.md) | API リファレンス（読み物版。契約との一致は `tests/api-docs.test.ts` が見る） |
| [`deploy.md`](./deploy.md) | Vercel + Supabase への配備手順と、サーバーレスでの制限 |
| [`load-test.md`](./load-test.md) | 負荷試験レポート（同時 100 リクエスト・配備からデモ動作までの実測） |
| [`known-issues.md`](./known-issues.md) | 既知の問題（**未解決のバグの正本**）と既知の制限 |
| [`../openapi/openapi.yaml`](../openapi/openapi.yaml) | REST API の定義（`npm run gen` で型生成） |
| [`screenshots/`](./screenshots/) | README 用のスクショとデモ動画（`npm run capture:screenshots` の生成物） |
