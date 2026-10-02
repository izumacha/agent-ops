// src 配下の TypeScript を「綴りではなく構文」で走査するための共通部品。
// 正規表現で検出網を書くと、コメントや文字列リテラルを拾って**緩む**方向にも**巻き込む**方向にも壊れる
// (このリポジトリが繰り返し避けている形)。TypeScript のパーサに読ませれば、コメント中の記述は
// トークンにならず、判定を実際の構文に固定できる
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

// 走査の根 (アプリのソース。生成物は除く)
export const SRC_DIR = join(process.cwd(), 'src');

// 生成物のディレクトリ名 (Prisma / OpenAPI の出力は人が書いたコードではない)
const GENERATED_DIR = 'generated';

// src 配下の .ts / .tsx を集める (生成物は除く)
export function findSourceFiles(dir: string = SRC_DIR): string[] {
  // 直下の要素を見る
  return readdirSync(dir).flatMap((entry) => {
    // 絶対パス
    const full = join(dir, entry);
    // 生成物のディレクトリには入らない
    if (entry === GENERATED_DIR) return [];
    // ディレクトリなら潜る
    if (statSync(full).isDirectory()) return findSourceFiles(full);
    // TypeScript のファイルだけ拾う
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

// 1 ファイル分の構文木 (パスと合わせて返す)
export interface ParsedSourceFile {
  path: string;
  source: ts.SourceFile;
}

// src 配下を丸ごと構文木にする (走査結果はモジュール評価時に 1 度だけ作って使い回す)
export function parseSourceFiles(): ParsedSourceFile[] {
  // ファイルごとに読んで構文木にする
  return findSourceFiles().map((path) => ({
    path,
    source: ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true),
  }));
}

// 構文木のすべてのノードを順に渡す (再帰は 1 か所に閉じる)
export function forEachNode(node: ts.Node, visit: (node: ts.Node) => void): void {
  // このノードを渡す
  visit(node);
  // 子も同じように辿る
  node.forEachChild((child) => forEachNode(child, visit));
}

/**
 * import の指定子を src 配下の絶対パスへ解決する。
 *
 * 対象はパスエイリアス (`@/…`) と相対指定子だけで、パッケージ名 (`next` など) は null を返す
 * — 追いたいのは**自分たちのモジュールの連鎖**で、依存の中身は別の関心事。
 * @param fromFile その指定子を書いているファイルの絶対パス
 * @param specifier import / export の指定子
 * @returns 解決できた絶対パス (できなければ null)
 */
export function resolveSourceSpecifier(fromFile: string, specifier: string): string | null {
  // 解決の起点 (エイリアスなら src から、相対ならそのファイルのディレクトリから)
  const base = specifier.startsWith('@/')
    ? join(SRC_DIR, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(fromFile), specifier)
      : null;
  // パッケージ名は対象外
  if (base === null) return null;
  // 拡張子は書かれないので、ファイルかディレクトリの index かを順に試す。
  // **`index.tsx` も候補に入れる** — 入れていなかった頃は、モジュールがディレクトリ化されて
  // 入口が `index.tsx`（Client Component を含む束ね）になった瞬間に解決できなくなり、
  // import の連鎖から導く検出網（レート制限の掛け忘れ・`fanOut` の枠）がそのルートを
  // **黙って対象から外したまま緑になる**（`costly.length > 0` の fail-closed は他のルートで
  // 満たされるので発火しない）。Next.js は `.tsx` の index を普通に解決する
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    // 実在する最初の候補を採る
    if (existsSync(candidate)) return candidate;
  }
  // 解決できなかった (型だけの指定子など)
  return null;
}

/**
 * そのファイルが取り込んでいる**自分たちのモジュール**の絶対パスを返す。
 *
 * **指定子は正規表現ではなくパーサから取る** — コメントや文字列リテラルの中の `from '…'` を
 * 拾うと検出網が緩む方向にも巻き込む方向にも壊れる (このファイル冒頭の方針と同じ)。
 * 見るのは静的 import・再公開 (`export … from`)・動的 `import()` の 3 つ。
 * @param parsed 構文木つきのファイル
 * @returns 取り込み先の絶対パス (重複なし)
 */
export function importedModulesOf(parsed: ParsedSourceFile): string[] {
  // 集めた指定子
  const specifiers: string[] = [];
  // 構文木を辿る
  forEachNode(parsed.source, (node) => {
    // 静的 import と再公開は moduleSpecifier を持つ
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
      return;
    }
    // 動的 import は「呼び出し式の関数部分が import キーワード」の形
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
  });
  // 解決できたものだけを重複なしで返す
  return [
    ...new Set(
      specifiers
        .map((specifier) => resolveSourceSpecifier(parsed.path, specifier))
        .filter((path): path is string => path !== null),
    ),
  ];
}

/**
 * src 全体の import グラフを 1 度だけ作る (ファイルごとの取り込み先の表)。
 * @returns 絶対パス → 取り込み先の絶対パスの一覧
 */
export function sourceImportGraph(): Map<string, string[]> {
  // すべてのファイルを構文木にして取り込み先を集める
  return new Map(parseSourceFiles().map((parsed) => [parsed.path, importedModulesOf(parsed)]));
}

/**
 * `entry` から import を辿って `target` へ到達できるか (推移的)。
 *
 * **「直接の import だけ」では足りない** — 間に 1 枚挟むだけで検出網から外れる。
 * @param graph sourceImportGraph() の結果 (呼び出しごとに作り直さない)
 * @param entry 起点の絶対パス
 * @param target 到達を調べる絶対パス
 * @returns 到達できれば true (entry 自身は数えない)
 */
export function reachesModule(
  graph: Map<string, string[]>,
  entry: string,
  target: string,
): boolean {
  // 訪問済み (循環 import で止まらなくならないように)
  const seen = new Set<string>();
  // 未訪問の積み
  const stack = [entry];
  // 深さ優先で辿る
  while (stack.length > 0) {
    // 次に見るファイル
    const current = stack.pop() as string;
    // すでに見たら飛ばす
    if (seen.has(current)) continue;
    seen.add(current);
    // 目的地に着いた (起点そのものは数えない)
    if (current === target && current !== entry) return true;
    // 取り込み先を積む
    stack.push(...(graph.get(current) ?? []));
  }
  // 辿り切っても着かなかった
  return false;
}
