// Next.js が Route Handler として扱うファイルの走査規則。route.ts に決め打ちすると、
// route.tsx / route.js に置いた素のハンドラが**全検査の外**へ落ちる（実測: 認証も認可も無い
// エンドポイントを置いても全件緑のまま `next build` のルート表に現れ、実際に配信された）。
// 走査する側が 2 か所（tests/route-wrapping.test.ts / tests/openapi.test.ts）あるので規則はここに 1 つだけ置く
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Next.js の既定 pageExtensions は ['tsx','ts','jsx','js']。将来足されても取りこぼさないよう
// mjs / cjs も含めて広めに拾う（拾いすぎても「検査の対象が増える」方向にしか効かない）
export const ROUTE_FILE_PATTERN = /^route\.(ts|tsx|js|jsx|mjs|cjs)$/;

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
