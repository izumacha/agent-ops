// Next.js のレスポンスヘルパー
import { NextResponse } from 'next/server';
// アプリ全体で共有する Prisma クライアント (遅延生成)
import { prisma } from '@/lib/prisma';
// OpenAPI から生成した応答の型
import type { HealthDto } from '@/lib/api-types';
// HTTP ステータスの唯一の参照元 (§6)
import { HTTP_STATUS } from '@/lib/api/http-status';
// エラーをログへ落とす形の唯一の参照元 (message を出さず name / code / フレームだけを残す)
import { describeError } from '@/lib/api/handler';
// 保存を禁じる Cache-Control の値 (route() が全ルートへ付けているのと同じ値。唯一の参照元は constants)
import { NO_STORE_CACHE_CONTROL } from '@/lib/constants';

// 応答に付けるキャッシュ制御 (成功・失敗のどちらにも同じものを付ける)
const CACHE_HEADERS = { 'Cache-Control': NO_STORE_CACHE_CONTROL };

// DB を毎回叩くので、Next.js の静的化を無効にして常に動的に応答する
export const dynamic = 'force-dynamic';

// GET /api/v1/health: アプリと DB の生存確認 (OpenAPI の servers.url=/api/v1 + /health と一致させる) (docker compose の healthcheck と Step7 の起動確認が使う)
export async function GET(): Promise<NextResponse<HealthDto>> {
  // DB へ最小のクエリを投げて到達性を確かめる
  try {
    // SELECT 1 が返れば DB は生きている
    await prisma.$queryRaw`SELECT 1`;
    // 正常応答 (OpenAPI の Health スキーマに一致させる)
    // このルートだけは route() を通らないので、キャッシュ制御は自分で付ける。
    // 付けないと前段のキャッシュ層が DB 障害中も古い ok:true を配り、生存確認が「健康」と答え続ける
    return NextResponse.json({ ok: true, db: 'up' }, { headers: CACHE_HEADERS });
  } catch (error) {
    // 内部詳細は応答へ返さず、サーバログにだけ残す (§9)。
    // **message は出さない。** ドライバの接続失敗は message に DSN をそのまま埋める
    // (`connect ECONNREFUSED postgresql://user:password@host:5432/db`) ため、素で出すと
    // 接続情報がログへ流れる。しかも compose の healthcheck が 10 秒ごとに叩くので、
    // DB 障害中は同じ 1 行が毎分 6 回積まれ続ける。route() が通る経路と同じ describeError に
    // 通し、種類 (name / code) と発生箇所だけを残す
    console.error('[health] DB 到達性チェックに失敗:', describeError(error));
    // 503 で「DB が落ちている」ことだけを伝える
    return NextResponse.json(
      { ok: false, db: 'down' },
      { status: HTTP_STATUS.SERVICE_UNAVAILABLE, headers: CACHE_HEADERS },
    );
  }
}
