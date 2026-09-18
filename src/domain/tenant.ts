// テナントに関する Prisma/Next 非依存の定数。seed と開発用 CLI が共有する唯一の定義。
// API 文言の集約 (src/lib/constants.ts) には置かない — あちらは MICRO_USD_MAX 等を引くので、
// seed の import グラフ (Dockerfile の COPY 列挙と tests/docker-seed-files.test.ts が突き合わせる) が
// API 側の都合で広がってしまう

// 開発・デモ用テナントの固定 id (seed が作り、CLI の --tenant の既定値になる)
export const DEFAULT_TENANT_ID = 'default-tenant';
