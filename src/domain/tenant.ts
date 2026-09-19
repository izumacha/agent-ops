// テナントに関する Prisma/Next 非依存の定数 (src/domain の他モジュールと同じく、DB もフレームワークも要らない値)。
// seed・開発用 CLI・将来のテストが共有する唯一の定義で、API 文言の集約 (src/lib/constants.ts) には置かない
// — あちらは API の上限値や日本語文言を抱えるため、seed の import グラフ (Dockerfile の COPY 列挙と
// tests/docker-seed-files.test.ts が突き合わせる) が API 側の都合で広がる

// 開発・デモ用テナントの固定 id (seed が作り、CLI の --tenant の既定値になる)
export const DEFAULT_TENANT_ID = 'default-tenant';
