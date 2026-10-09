// Next.js のレスポンスヘルパー
import { NextResponse } from 'next/server';
// アプリ全体で共有する Prisma クライアント (遅延生成)
import { prisma } from '@/lib/prisma';
// OpenAPI から生成した応答の型
import type { HealthDto } from '@/lib/api-types';
// HTTP ステータスの唯一の参照元 (§6)
import { HTTP_STATUS } from '@/lib/api/http-status';
// エラーをログへ落とす形の唯一の参照元 (message を出さず name / code / フレームだけを残す)
import { describeError } from '@/lib/describe-error';
import { logEventThrottled } from '@/lib/log';
// 応答を数え、例外を応答へ写し、**キャッシュ制御を付ける**共通のラッパー
// (route() を通らない経路もこれを使う)
import { withResponseCount } from '@/lib/api/response-count';

// DB を毎回叩くので、Next.js の静的化を無効にして常に動的に応答する
export const dynamic = 'force-dynamic';

// GET /api/v1/health: アプリと DB の生存確認 (OpenAPI の servers.url=/api/v1 + /health と一致させる) (docker compose の healthcheck と Step7 の起動確認が使う)
// **応答を数えるのは `withResponseCount` が受け持つ** (route() を通らない経路でも同じ 1 本を使う。
// compose の healthcheck が 10 秒ごとに叩くので、503 の系列は DB 障害の継続時間をそのまま表す)
export const GET = withResponseCount(probe);

// DB へ問い合わせて生存を確かめる (包む側が数えるので、ここは応答を作るだけ)
async function probe(): Promise<NextResponse<HealthDto>> {
  // DB へ最小のクエリを投げて到達性を確かめる
  try {
    // SELECT 1 が返れば DB は生きている
    await prisma.$queryRaw`SELECT 1`;
    // 正常応答 (OpenAPI の Health スキーマに一致させる)。
    // **キャッシュ制御は書かない** — 付けるのは包む側 (`withResponseCount`) の 1 か所。
    // 付け忘れると前段のキャッシュ層が DB 障害中も古い ok:true を配り、生存確認が「健康」と
    // 答え続けるので、**どのルートも自分では決めない**形にしてある
    // (自分でも付けていた経路は `Vary` が二重に並んでいた＝実測)
    return NextResponse.json({ ok: true, db: 'up' });
  } catch (error) {
    // 内部詳細は応答へ返さず、サーバログにだけ残す (§9)。
    // **message は出さない。** ドライバの接続失敗は message に DSN をそのまま埋める
    // (`connect ECONNREFUSED postgresql://user:password@host:5432/db`) ため、素で出すと
    // 接続情報がログへ流れる。route() が通る経路と同じ describeError に通し、
    // 種類 (name / code) と発生箇所だけを残す。
    // **間引く側で出す。** この経路は未認証・枠なしで誰でも叩けるので (`route()` を通らない
    // 理由付きの表に登録してある)、1 要求 1 行だと匿名の相手がログの量 (＝保存の費用) を
    // 好きなだけ増やせる。DB 障害中は診断の中身も同じなので、落ちるのは重複だけ
    logEventThrottled('health.db_unreachable', describeError(error));
    // 503 で「DB が落ちている」ことだけを伝える
    return NextResponse.json(
      { ok: false, db: 'down' },
      { status: HTTP_STATUS.SERVICE_UNAVAILABLE },
    );
  }
}
