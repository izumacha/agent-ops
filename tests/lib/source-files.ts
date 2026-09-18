// src 配下の TypeScript を「綴りではなく構文」で走査するための共通部品。
// 正規表現で検出網を書くと、コメントや文字列リテラルを拾って**緩む**方向にも**巻き込む**方向にも壊れる
// (このリポジトリが繰り返し避けている形)。TypeScript のパーサに読ませれば、コメント中の記述は
// トークンにならず、判定を実際の構文に固定できる
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
