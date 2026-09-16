// Next.js のレスポンスヘルパー
import { NextResponse } from 'next/server';
// アプリ全体で共有する Prisma クライアント (遅延生成)
import { prisma } from '@/lib/prisma';
// OpenAPI から生成した応答の型
import type { HealthDto } from '@/lib/api-types';

// DB を毎回叩くので、Next.js の静的化を無効にして常に動的に応答する
export const dynamic = 'force-dynamic';

// GET /api/health: アプリと DB の生存確認 (docker compose の healthcheck と Step7 の起動確認が使う)
export async function GET(): Promise<NextResponse<HealthDto>> {
  // DB へ最小のクエリを投げて到達性を確かめる
  try {
    // SELECT 1 が返れば DB は生きている
    await prisma.$queryRaw`SELECT 1`;
    // 正常応答 (OpenAPI の Health スキーマに一致させる)
    return NextResponse.json({ ok: true, db: 'up' });
  } catch (error) {
    // 内部詳細 (接続文字列など) は返さず、サーバログにだけ残す (§9)
    console.error(
      '[health] DB 到達性チェックに失敗:',
      error instanceof Error ? error.message : error,
    );
    // 503 で「DB が落ちている」ことだけを伝える
    return NextResponse.json({ ok: false, db: 'down' }, { status: 503 });
  }
}
