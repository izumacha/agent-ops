// 生成された Prisma クライアントの型 (Proxy の型付けに使う)
import type { PrismaClient } from '@/generated/prisma';
// ドライバアダプタの結線を 1 か所に集めたファクトリ
import { createPrismaClient } from './prisma-client';

// 開発時のホットリロードで PrismaClient が増殖しないよう、グローバルに 1 つだけ保持する
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// 実際のクライアントを必要になった瞬間に 1 度だけ生成する (遅延生成)
function getClient(): PrismaClient {
  // 既に生成済みならそれを返す
  if (globalForPrisma.prisma) return globalForPrisma.prisma;
  // 未生成なら作ってグローバルへ保存する (本番では 1 プロセス 1 インスタンス)
  const client = createPrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });
  globalForPrisma.prisma = client;
  // 生成したクライアントを返す
  return client;
}

/**
 * アプリ全体で共有する Prisma クライアント (遅延生成の Proxy)。
 * import しただけでは DB に接続しないため、DB を触らないユニットテストが巻き添えで落ちない。
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  // プロパティ参照のたびに実クライアントへ委譲する
  get(_target, property, receiver) {
    // 実クライアントの該当プロパティを取り出す
    const value = Reflect.get(getClient(), property, receiver);
    // メソッドなら this が実クライアントになるよう束縛して返す
    return typeof value === 'function' ? value.bind(getClient()) : value;
  },
});
