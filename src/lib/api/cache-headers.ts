// 応答に付ける「保存するな・Authorization で分けろ」のヘッダ。
// route() が包む全応答と、入口の proxy (src/proxy.ts) が返す応答の両方が同じ 1 か所を使う
// (片方だけに付けると、規律から外れた経路が 1 つ残る)
import { NO_STORE_CACHE_CONTROL } from '@/lib/constants';

/**
 * `Vary` に並べる「資格情報を運ぶヘッダ」。
 *
 * **`Authorization` だけでは足りない。** 画面側の CSV（`src/app/(dashboard)/reports/daily`）は
 * セッション **Cookie** で認証してテナント固有の利用量・コストを返すので、`Authorization`
 * だけを鍵にすると**どのテナントも `Authorization` を送らない**＝鍵が衝突する。前段の CDN が
 * その経路をキャッシュ対象に含めて `no-store` を尊重しない設定だと、A の CSV が B へ配られる。
 * この関数が担っているのはまさにその多層防御なので、**実際に使っている資格情報を全部並べる**。
 *
 * 経路ごとに並べ分けない: 鍵が増えても `no-store` と併記するだけで保存はされず、
 * 「どの経路がどの資格情報を使うか」を押印の側が知る形にすると、経路を足す人が決め直すことに
 * なる（この PR がヘッダを 1 か所へ寄せた理由と同じ）。
 */
const CREDENTIAL_HEADERS = ['Authorization', 'Cookie'] as const;

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
  for (const field of CREDENTIAL_HEADERS) {
    // その項目が既に並んでいれば足さない
    if (!varyLists(headers.get('Vary'), field)) headers.append('Vary', field);
  }
  // 本文・状態はそのままで作り直す (204 の null 本文もそのまま通る)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * `Vary` が既にその項目を並べているか。
 *
 * **`*` も「すべてで分ける」なので足さない**（RFC 9110。`Vary: *` のある応答へ項目を足すと
 * 意味の無い項目が増える）。比較は大文字小文字を無視する（フィールド名は大文字小文字を
 * 区別しない）。
 * @param vary いまの `Vary` の値（無ければ null）
 * @param field 並んでいるか調べる項目（**綴りは問わない** — この関数が両辺を小文字へそろえる。
 *   呼び出し側の `CREDENTIAL_HEADERS` はヘッダ名の慣習どおり大文字始まりで持つ）
 * @returns 既に並んでいれば true
 */
function varyLists(vary: string | null, field: string): boolean {
  // ヘッダが無ければ並んでいない
  if (vary === null) return false;
  // カンマ区切りの項目に分け、前後の空白を落として突き合わせる
  return vary
    .split(',')
    .map((listed) => listed.trim().toLowerCase())
    .some((listed) => listed === field.toLowerCase() || listed === '*');
}
