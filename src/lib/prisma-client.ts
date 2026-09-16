// Prisma 7 で必須になったドライバアダプタ (node-postgres 版) をインポート
import { PrismaPg } from '@prisma/adapter-pg';
// 生成された Prisma クライアント本体と、ログ設定の型をインポート
import { Prisma, PrismaClient } from '@/generated/prisma';

// Prisma 5 のクエリエンジンが持っていた既定の待ち時間 (秒)。
// node-postgres は既定で「無期限に待つ」ため、そのままだと DB 到達不能がエラーではなくハングになる
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;

/**
 * PrismaClient を生成する共通ファクトリ。
 * Prisma 7 は datasource.url を schema.prisma に書けないため、接続文字列は毎回ここで結線する。
 * アプリの singleton (src/lib/prisma.ts)・seed・契約テストはすべてこれを経由する (結線を 1 か所に集める)。
 */
// PrismaClient を生成する共通ファクトリ (ログ設定だけ呼び出し側が指定できる)
export function createPrismaClient(options?: {
  // Prisma が出力するログの種類 (省略時は Prisma の既定に任せる)
  log?: (Prisma.LogLevel | Prisma.LogDefinition)[];
}): PrismaClient {
  // 接続文字列を環境変数から取り出す
  const connectionString = process.env.DATABASE_URL;

  // 接続文字列が無いまま進むと実行時まで気付けないので、ここで明示的に落とす (fail-closed)
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL が未設定です。Prisma 7 はドライバアダプタ経由で接続するため、接続文字列が必須です。',
    );
  }

  // node-postgres のコネクションプールを内部に持つアダプタを組み立てる
  const adapter = new PrismaPg(
    {
      // 接続先
      connectionString,
      // 接続確立の上限 (ミリ秒)。無期限待ちを避ける
      connectionTimeoutMillis: DEFAULT_CONNECT_TIMEOUT_SECONDS * 1000,
    },
    {
      // プールや待機中コネクションのエラーを握り潰さない (接続文字列を含まない安全なメッセージだけ残す)
      onPoolError: (error: Error) => console.error('[prisma] 接続プールでエラー:', error.message),
      onConnectionError: (error: Error) =>
        console.error('[prisma] コネクションでエラー:', error.message),
    },
  );

  // アダプタを渡して PrismaClient を生成し、呼び出し側へ返す
  return new PrismaClient({ adapter, ...(options?.log ? { log: options.log } : {}) });
}
