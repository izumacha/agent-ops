// Prisma 7 の設定ファイル。Prisma 7 から datasource の接続 URL は schema.prisma に書けなくなり、
// CLI 用の接続情報と seed コマンドはここへ集約する。参照: https://pris.ly/d/config-datasource
// .env を読み込む副作用付き import (Prisma 7 の CLI はこの設定ファイルの評価時に .env を自動で読まない)
import 'dotenv/config';
// defineConfig で型付きの設定を作る関数をインポート
import { defineConfig } from 'prisma/config';

// CLI が使う接続先。migrate / db seed のときだけ必要になる
const databaseUrl = process.env.DATABASE_URL;

// Prisma CLI (generate / migrate / db seed) が読み込む設定を既定エクスポートする
export default defineConfig({
  // スキーマファイルの場所 (Prisma 7 では既定探索に頼らず明示する)
  schema: 'prisma/schema.prisma',
  // datasource は「値があるときだけ」載せる。env() は評価時に即解決して未設定なら例外を投げるため、
  // 素朴に書くと DB を必要としない `prisma generate` (CI の lint ジョブ / Dockerfile の builder) まで落ちる
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),
  // マイグレーション関連の設定
  migrations: {
    // `prisma db seed` が実行するコマンド。ここが唯一の定義 (package.json には書き写さない)
    seed: 'tsx prisma/seed.ts',
  },
});
