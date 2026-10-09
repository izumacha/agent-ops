// Next.js が Route Handler として扱うファイルの走査規則。route.ts に決め打ちすると、
// route.tsx / route.js に置いた素のハンドラが**全検査の外**へ落ちる（実測: 認証も認可も無い
// エンドポイントを置いても全件緑のまま `next build` のルート表に現れ、実際に配信された）。
// 走査する側が 2 か所（tests/route-wrapping.test.ts / tests/openapi.test.ts）あるので規則はここに 1 つだけ置く
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Next.js の既定 pageExtensions（node_modules/next/dist/server/config-shared.js）。
// route.* だけでなく proxy.* / middleware.* の検出にも同じ表が使われるので、ここを唯一の源にする。
// 設定で変えていないことは tests/route-wrapping.test.ts が固定する
export const PAGE_EXTENSIONS = ['tsx', 'ts', 'jsx', 'js'] as const;

// Route Handler として扱われるファイル名 (上の拡張子 + 念のため mjs / cjs)
export const ROUTE_FILE_PATTERN = new RegExp(
  `^route\\.(?:${[...PAGE_EXTENSIONS, 'mjs', 'cjs'].join('|')})$`,
);

// このリポジトリで書いてよい唯一の綴り（他の拡張子は禁止する。詳細は tests/route-wrapping.test.ts）
export const ALLOWED_ROUTE_FILE_NAME = 'route.ts';

// ディレクトリを再帰して Route Handler のファイルを集める
export function findRouteFiles(dir: string): string[] {
  // 直下の要素
  return readdirSync(dir).flatMap((entry) => {
    // 絶対パス
    const full = join(dir, entry);
    // ディレクトリなら潜る
    if (statSync(full).isDirectory()) return findRouteFiles(full);
    // Route Handler として扱われる名前だけを拾う
    return ROUTE_FILE_PATTERN.test(entry) ? [full] : [];
  });
}

/**
 * Next.js が Route Handler として呼ぶ export 名。
 *
 * **5 つに絞ると `HEAD` / `OPTIONS` が死角になる。** Next.js は `HEAD` を **`GET` の
 * ハンドラを呼んで**応え、`OPTIONS` は自分で実装するので、export が無くても**届く**
 * （「export の無いメソッドは 405」は成り立たない）。
 *
 * 読む側が 2 か所ある: `tests/route-wrapping.test.ts` は「この名前の export が結線を
 * 通っているか」を見て、`tests/metrics.test.ts` は「**この名前のメソッドがメトリクスの
 * ラベルの閉じた集合に入っているか**」を見る。後者にとってこれは**独立な手掛かり**で、
 * `KNOWN_METHODS` 自身から導くと「集合から外した分は検査のケースからも消える」ので
 * 外す変異が素通りする（実測で全件緑だった）。
 */
export const HTTP_METHOD_EXPORTS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
] as const;
