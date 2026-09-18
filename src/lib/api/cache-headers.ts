// 応答に付ける「保存するな・Authorization で分けろ」のヘッダ。
// route() が包む全応答と、入口の proxy (src/proxy.ts) が返す応答の両方が同じ 1 か所を使う
// (片方だけに付けると、規律から外れた経路が 1 つ残る)
import { NO_STORE_CACHE_CONTROL } from '@/lib/constants';

/**
 * 応答に「保存するな・Authorization で分けろ」を付ける。全ルートがテナント固有の内容を返すので、
 * URL だけを鍵にするキャッシュ (CDN・リバースプロキシ) が別テナントへ配ってしまうのを防ぐ。
 * RFC 9111 は Authorization 付きの要求を既定で共有キャッシュに保存させないが、`/api/*` を一律にキャッシュする
 * 設定はよくあるので、アプリ側でも明示する (テナント境界をアプリの where 条件だけに頼らない)
 */
export function withPrivateCacheHeaders(response: Response): Response {
  // 既存のヘッダを引き継ぐ
  const headers = new Headers(response.headers);
  // 保存させない
  headers.set('Cache-Control', NO_STORE_CACHE_CONTROL);
  // 万一保存されても資格情報ごとに分ける
  headers.append('Vary', 'Authorization');
  // 本文・状態はそのままで作り直す (204 の null 本文もそのまま通る)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
