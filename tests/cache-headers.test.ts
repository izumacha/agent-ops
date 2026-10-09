// 「保存するな・Authorization で分けろ」を付ける 1 か所（`src/lib/api/cache-headers.ts`）の検査。
//
// この関数は**包むラッパー（`withResponseCount`）と入口（`src/proxy.ts`）の 2 か所から
// 呼ばれる**ので、挙動が 2 度掛かったときに崩れないことまで固定する。以前は包む側と
// 包まれる側の両方が呼んでいて、**全 API 応答が `Vary: Authorization, Authorization` を
// 返していた**（実測。`append` は冪等でないため）。重複を消したのは別の差分だが、
// この関数の側も「2 度通しても同じ」にしてある。
import { describe, expect, it } from 'vitest';
import { withPrivateCacheHeaders } from '@/lib/api/cache-headers';
import { NO_STORE_CACHE_CONTROL } from '@/lib/constants';

describe('キャッシュ禁止のヘッダ', () => {
  it('保存禁止と、資格情報を運ぶヘッダでの分離を付ける', () => {
    // 素の応答に付ける
    const response = withPrivateCacheHeaders(new Response('x'));
    // 保存させない
    expect(response.headers.get('cache-control')).toBe(NO_STORE_CACHE_CONTROL);
    // **`Cookie` も並べる** — 画面側の CSV はセッション Cookie で認証してテナント固有の
    // 数字を返すので、`Authorization` だけを鍵にすると**どのテナントも送らない**＝鍵が衝突する
    expect(response.headers.get('vary')).toBe('Authorization, Cookie');
  });

  it('2 度通しても Vary の項目は 1 回だけ並ぶ（冪等）', () => {
    // 同じ応答へ 2 度通す（包む側と包まれる側の両方が呼んでいた形）
    const response = withPrivateCacheHeaders(withPrivateCacheHeaders(new Response('x')));
    // 並ぶのは 1 回ずつ
    expect(response.headers.get('vary')).toBe('Authorization, Cookie');
  });

  it('既にある Vary の項目は消さず、足りないものだけを足す', () => {
    // 別の項目を持つ応答
    const response = withPrivateCacheHeaders(
      new Response('x', { headers: { Vary: 'Accept-Encoding' } }),
    );
    // 既存の項目は残り、資格情報の 2 つが足される
    expect(response.headers.get('vary')).toBe('Accept-Encoding, Authorization, Cookie');
  });

  it('大文字小文字が違う既存の項目も「ある」と見なす（フィールド名は区別しない）', () => {
    // 綴りだけが違う形
    const response = withPrivateCacheHeaders(
      new Response('x', { headers: { Vary: 'authorization, cookie' } }),
    );
    // 足さない（2 度並べない）
    expect(response.headers.get('vary')).toBe('authorization, cookie');
  });

  it('一部だけ並んでいる Vary には足りない項目だけを足す', () => {
    // Cookie だけが並んでいる応答
    const response = withPrivateCacheHeaders(new Response('x', { headers: { Vary: 'Cookie' } }));
    // Authorization だけが足される（順序は既存のものが先）
    expect(response.headers.get('vary')).toBe('Cookie, Authorization');
  });

  it('値が空の Vary に通しても空の要素を作らない（RFC 9110 の 1#field-name を守る）', () => {
    // 値が空の Vary を持つ応答（ハンドラが `Vary: ''` を付けた場合）
    const response = withPrivateCacheHeaders(new Response('x', { headers: { Vary: '' } }));
    // 先頭に空の要素（`, Authorization, Cookie`）を作らず、2 項目だけを並べる
    expect(response.headers.get('vary')).toBe('Authorization, Cookie');
  });

  it('空白だけの要素は落として並べ直す', () => {
    // カンマだけ・空白だけの要素が混ざった Vary
    const response = withPrivateCacheHeaders(
      new Response('x', { headers: { Vary: ' , Cookie ,  ' } }),
    );
    // 空の要素は消え、足りない Authorization だけが後ろへ付く
    expect(response.headers.get('vary')).toBe('Cookie, Authorization');
  });

  it('Vary: * には何も足さない（すべてで分ける指定の意味を薄めない）', () => {
    // すべてで分ける指定
    const response = withPrivateCacheHeaders(new Response('x', { headers: { Vary: '*' } }));
    // そのまま
    expect(response.headers.get('vary')).toBe('*');
  });

  it('本文・状態・既存のヘッダはそのまま通す', async () => {
    // 本文と状態と独自ヘッダを持つ応答
    const response = withPrivateCacheHeaders(
      new Response('body', { status: 418, headers: { 'X-Keep': 'yes' } }),
    );
    // 状態・独自ヘッダ・本文のいずれも変わらない
    expect(response.status).toBe(418);
    expect(response.headers.get('x-keep')).toBe('yes');
    expect(await response.text()).toBe('body');
  });

  it('本文を持てない応答（204）も壊さない', () => {
    // 204 は本文を持てない（new Response(null) でないと例外になる）
    const response = withPrivateCacheHeaders(new Response(null, { status: 204 }));
    // 状態とヘッダが付くこと
    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe(NO_STORE_CACHE_CONTROL);
  });
});
