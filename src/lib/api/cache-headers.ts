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
  // 万一保存されても資格情報ごとに分ける。**既に並んでいれば足さない** — `append` は
  // 冪等ではないので、同じ応答へ 2 度通すと `Vary: Authorization, Authorization` になる
  // （実測。包む側と包まれる側が両方これを呼んでいた頃の `/metrics` が実際にそうだった）。
  // 二重に並んでも意味は同じだが、ヘッダは応答の契約なので「同じ値を設定し直すだけ」が
  // 本当にそうである形にしておく
  if (!varyListsAuthorization(headers.get('Vary'))) {
    headers.append('Vary', 'Authorization');
  }
  // 本文・状態はそのままで作り直す (204 の null 本文もそのまま通る)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * `Vary` が既に `Authorization` を並べているか。
 *
 * **`*` も「すべてで分ける」なので足さない**（RFC 9110。`Vary: *` のある応答へ
 * `Authorization` を足すと意味の無い項目が増える）。比較は大文字小文字を無視する
 * （フィールド名は大文字小文字を区別しない）。
 * @param vary いまの `Vary` の値（無ければ null）
 * @returns 既に並んでいれば true
 */
function varyListsAuthorization(vary: string | null): boolean {
  // ヘッダが無ければ並んでいない
  if (vary === null) return false;
  // カンマ区切りの項目に分け、前後の空白を落として突き合わせる
  return vary
    .split(',')
    .map((field) => field.trim().toLowerCase())
    .some((field) => field === 'authorization' || field === '*');
}
