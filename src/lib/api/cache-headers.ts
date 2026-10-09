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
  // 万一保存されても資格情報ごとに分ける。**組み立て直して 1 度 set する**（`append` を
  // 使わない） — `append` は冪等でないので同じ応答へ 2 度通すと
  // `Vary: Authorization, Authorization` になり（実測。包む側と包まれる側が両方これを
  // 呼んでいた頃の `/metrics` が実際にそうだった）、**値が空のヘッダがあると先頭に空の
  // 要素を作る**（実測: `Vary: ''` の応答へ通すと `Vary: ", Authorization, Cookie"`。
  // RFC 9110 の `Vary` は `1#field-name` なので空の要素は文法違反で、解析に失敗した
  // 共有キャッシュがヘッダを丸ごと無視すると、この関数が防いでいる多層防御が消える）
  const varyBefore = headers.get('Vary');
  // いま並んでいる項目。**空の要素は落とす**（上記の文法違反を持ち込まないため）
  const listed = (varyBefore ?? '')
    .split(',')
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
  // `*` は「すべてで分ける」なので、あれば項目を足さない（RFC 9110。足しても意味が無い）
  const varyAll = listed.some((field) => field === '*');
  // まだ並んでいない資格情報のヘッダ名（比較は大文字小文字を無視する）
  const missing = varyAll
    ? []
    : CREDENTIAL_HEADERS.filter(
        (field) => !listed.some((entry) => entry.toLowerCase() === field.toLowerCase()),
      );
  // 並べるものがあれば組み立てて 1 度だけ設定する
  if (listed.length > 0 || missing.length > 0) {
    headers.set('Vary', [...listed, ...missing].join(', '));
  } else if (varyBefore !== null) {
    // 並べるものが 1 つも無いのにヘッダだけある（空文字など）なら、文法違反を残さず消す
    headers.delete('Vary');
  }
  // 本文・状態はそのままで作り直す (204 の null 本文もそのまま通る)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
