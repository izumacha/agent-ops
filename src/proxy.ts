// Next.js 16 の proxy ファイル規約 (旧 middleware.ts の後継。**エクスポート名は `proxy` 固定**)。
// 全リクエストの入口で、Next.js 本体が URL を解釈する前に「そもそも読めない要求」を落とす。
//
// **なぜ必要か**: 動的セグメントのパーセント符号化が壊れている要求 (`/api/v1/agents/%ff`・`%`・`%c0%80` 等) は、
// Next.js が `params` を組み立てるときの `decodeURIComponent` が `URIError` を投げて **500** になる。
// これは `src/lib/api/handler.ts` の `route()` の try/catch より手前なので、56 巡目に入れたセグメントの
// 形の検証 (`assertResourceIdParams`) には一切届かない。実測では **Authorization ヘッダ無し**で
// 動的セグメントを持つ全ルートが 500 を返し、応答はエラー契約 `{status, message}` ですらない素の
// `Internal Server Error` だった。資格情報なしで 5xx を無制限に作れる状態は、5xx 率で監視や
// サーキットブレーカを組んでいる配備でそのまま「障害の捏造」になる。
//
// **アプリで塞げない隣の穴**: `TRACE` などの未対応メソッドは Next.js が `Request` を組み立てる時点で
// 例外になるため、この proxy には一度も到達しない (実測)。あちらは前段のリバースプロキシで 405 に
// 落とす前提で、`docs/adr/0005-bearer-token-auth.md` の宿題に記載している。
//
// **本文サイズへの副作用**: proxy を置くと Next.js は非 GET の本文を入口で複製・バッファし、
// `experimental.proxyClientMaxBodySize` を超えた分をエラーにせず切り詰める。このバッファは
// **認証より前**に走るので、既定 (10 MiB) のままだと未認証の相手が 1 接続あたりその分の
// ヒープを握れる。そこで `next.config.ts` はこの値をアプリの本文上限から導いて絞っている
// (`src/lib/body-limits.ts` の `ENTRY_MAX_BODY_BYTES` = `JSON_BODY_MAX_BYTES` ＋ 余白)。
// 守るべき不変条件は「余白は 1 回のソケット読み取り以上、その 2 倍以内」で、定数側のコメントと
// `tests/proxy.test.ts` が固定する (小さすぎると切り詰めが「別の妥当な JSON」に化け、
// 大きすぎると未認証に握らせるヒープが既定へ戻る)。**保持時間はこの設定では直らない** —
// 本文を送り終えるまで応答は出ないので、本文のタイムアウトは前段のリバースプロキシで落とす
// (ADR-0005 の宿題)。
import { NextResponse, type NextRequest } from 'next/server';
import { withPrivateCacheHeaders } from '@/lib/api/cache-headers';
import { logEvent } from '@/lib/log';
import { errorResponse } from '@/lib/api/errors';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { API_MESSAGES } from '@/lib/constants';

/** パスが percent-decode できるか (できない要求は Next.js 本体へ渡すと 500 になる) */
function isDecodablePath(url: string): boolean {
  // 解釈できれば true、壊れていれば false (fail-closed)
  try {
    // URL の組み立てとパスの復号の両方を試す
    decodeURIComponent(new URL(url).pathname);
    return true;
  } catch {
    // URIError (壊れたパーセント符号化) や URL の組み立て失敗
    return false;
  }
}

// 読めないパスの 404 を 1 度ログへ出したか (未認証で叩ける経路なので毎回は出さない)
let warnedUndecodablePath = false;

// **この入口が `@/lib/log` を取り込む費用（測った上で受け入れている）。**
// `log.ts` は `@/lib/metrics` を取り込むので、1 本のログ行のために入口の束へカウンタの表と
// Prometheus の整形まで入り、モジュール評価時に `process.uptime()` / `Date.now()` を読む。
// しかも入口は別のモジュール実体なので、ここで数えた系列は `/metrics` から**原理的に読めない**
// （`logEvent` の説明にある実測）。それでも分けないのは、**`console` を呼べるのを 1 ファイルに
// 限る**という不変条件の方が強いから — 入口用に 2 つ目の出口を作ると、`describeError` を
// 通さない実引数や語彙に無い綴りがそちらから入る口ができる（`tests/error-logging.test.ts` の
// 守備範囲がファイル 1 つを前提にしている）。**費用は入口の起動時の評価だけ**で、
// 要求ごとの仕事は増えない。文書専用の表（`uncounted-response-sources.ts`）を
// `metrics.ts` から外したのは、あちらが**本番のコードから 1 度も読まれない**ので
// 同じ費用に見合うものが何も無かったため（こちらには 1 行の記録という用がある）。

// 全リクエストの入口 (Next.js が名前で呼ぶので、この関数名と export の形は変えない)
export function proxy(request: NextRequest): Response {
  // 読めないパスは「そんな資源は無い」として 404 で返す (500 にしない・本体まで通さない)。
  // 応答の形は API のエラー契約に揃える (この配備が持つ経路はほぼ API で、形が割れる方が扱いにくい)
  if (!isDecodablePath(request.url)) {
    // **この応答はメトリクスに現れない（実測）。** 入口は route handler とは別のモジュール実体で
    // 評価されるので、ここで `countHttpResponse` を呼んでも `/metrics` が読むカウンタとは
    // 別の表に入る（本番ビルドで確認: health の 200 は現れるのに、ここの 404 は 2 件とも
    // 現れなかった）。数えたように見えて見えない形を作るより、**ログで非可視だけは解く**。
    // 既知の非可視として ADR-0014 と docs/deploy.md にも書いてある
    if (!warnedUndecodablePath) {
      // **1 度だけ出す** — 未認証で誰でも叩ける経路なので、毎回出すとログを埋められる。
      // **間引いても率は失われない**: 読めないパスは URL の形そのものなので、前段の
      // アクセスログが 1 件ずつ記録している（この出来事の説明文もそう案内する）。
      // ここの 1 行が解いているのは「この配備が 404 にした」という非可視だけ。
      // **他の未認証経路（ログイン・越境・署名・監視トークン）は「窓あたり 1 本 ＋ 間引いた
      // 件数を行に載せる」形** (`logEventThrottled`)。こちらだけ 1 度きりにしてよいのは、
      // 読めないパスの率が**前段のアクセスログに 1 件ずつ残る**から (上記)
      warnedUndecodablePath = true;
      logEvent('entry.undecodable_path');
    }
    // キャッシュ制御も route() の応答と同じ規律に揃える (この 1 経路だけ外れていると、
    // 将来 proxy が分岐を増やしたときに気付けない)
    return withPrivateCacheHeaders(errorResponse(HTTP_STATUS.NOT_FOUND, API_MESSAGES.notFound));
  }
  // それ以外はそのまま先へ渡す
  return NextResponse.next();
}

// 静的アセットと画像最適化は素通しする (入口の処理を毎回通す意味が無いため)
export const config = {
  matcher: '/((?!_next/static|_next/image|favicon.ico).*)',
};
