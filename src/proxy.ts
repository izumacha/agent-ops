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
// `experimental.proxyClientMaxBodySize` (既定 10 MiB) を超えた分をエラーにせず切り詰める。
// このアプリの本文上限 `JSON_BODY_MAX_BYTES` (64 KiB) はその 1/160 なので、正規の要求も
// 413 を返す経路も影響を受けない。**上限を既定より大きくするときはここを見直すこと。**
import { NextResponse, type NextRequest } from 'next/server';
import { withPrivateCacheHeaders } from '@/lib/api/cache-headers';
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

// 全リクエストの入口 (Next.js が名前で呼ぶので、この関数名と export の形は変えない)
export function proxy(request: NextRequest): Response {
  // 読めないパスは「そんな資源は無い」として 404 で返す (500 にしない・本体まで通さない)。
  // 応答の形は API のエラー契約に揃える (この配備が持つ経路はほぼ API で、形が割れる方が扱いにくい)
  if (!isDecodablePath(request.url)) {
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
