// Vitest のテスト API
import { describe, expect, it } from 'vitest';
// ファイル読み込み (Node 標準)
import { readFileSync } from 'node:fs';
// パス操作 (Node 標準)
import { dirname, join, relative, resolve } from 'node:path';

// リポジトリのルート
const ROOT = process.cwd();
// seed の入口
const SEED_ENTRY = join(ROOT, 'prisma', 'seed.ts');
// import / 再エクスポート (export ... from) 文からモジュール指定子を取り出す正規表現
// (静的なものだけ。seed の import グラフに動的 import は無い)
const IMPORT_PATTERN = /^(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
// パスエイリアス `@/` の解決先 (tsconfig.json の paths と同じ)
const ALIAS_PREFIX = '@/';

// あるファイルから相対 import で辿れる src/ 配下のファイルを再帰的に集める
function collectSrcImports(file: string, seen = new Set<string>()): Set<string> {
  // ファイルを読む
  const source = readFileSync(file, 'utf8');
  // import 文を順に見る
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    // モジュール指定子 (例: '../src/lib/prisma-client')
    const specifier = match[1];
    // 相対 import と `@/` エイリアス以外 (npm パッケージ) は対象外
    const isAlias = specifier.startsWith(ALIAS_PREFIX);
    if (!specifier.startsWith('.') && !isAlias) continue;
    // 絶対パスへ解決し .ts 拡張子を補う (`@/x` は src/x)
    const target =
      (isAlias
        ? join(ROOT, 'src', specifier.slice(ALIAS_PREFIX.length))
        : resolve(dirname(file), specifier)) + '.ts';
    // リポジトリ相対のパスに正規化する
    const rel = relative(ROOT, target).split('\\').join('/');
    // src/ 配下の手書きファイルだけを集める (生成物 src/generated/ は Dockerfile がディレクトリごと
    // コピーし、prisma/ 等は別途まとめてコピーする)
    if (!rel.startsWith('src/') || rel.startsWith('src/generated/') || seen.has(rel)) continue;
    // 集合に加え、そのファイルの import も辿る
    seen.add(rel);
    collectSrcImports(target, seen);
  }
  // 集めた結果を返す
  return seen;
}

// Dockerfile の runner ステージが個別に COPY している src/ 配下のファイルを集める
function collectDockerfileSrcCopies(): Set<string> {
  // Dockerfile を読む
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
  // `COPY --from=builder /app/src/xxx.ts ./src/xxx.ts` の xxx.ts を拾う
  // (生成物ディレクトリ src/generated のまとめコピーは seed の import グラフとは別枠なので対象外)
  const copies = dockerfile.matchAll(/^COPY --from=builder \/app\/(src\/[^\s]+\.ts) /gm);
  // パスの集合にする
  return new Set([...copies].map((m) => m[1]));
}

describe('Dockerfile の seed 用ファイル列挙', () => {
  it('prisma/seed.ts が相対 import で参照する src/ 配下のファイルと過不足なく一致する', () => {
    // seed の import グラフ (src/ 配下)
    const needed = [...collectSrcImports(SEED_ENTRY)].sort();
    // Dockerfile の列挙
    const copied = [...collectDockerfileSrcCopies()].sort();
    // 足し忘れ (コンテナ内の db:seed が MODULE_NOT_FOUND) も、余分 (列挙の膨張) も落とす
    expect(copied).toEqual(needed);
  });
});
