// 画面の書き込み経路（Server Action）に、守りが**配線されているか**を見る検査（Step5）。
//
// **Route Handler には網があるのに、Server Action には無かった。** `tests/route-wrapping.test.ts`
// は「`route.ts` は必ず `route()` を通る」ことを実際のモジュールから確かめるが、Step5 で書き込みは
// Server Action へ移った。CLAUDE.md は守りの順序（Origin → セッション → CSRF → 入力 → RBAC）を
// 明記しているのに、それを機械で確かめるものが 1 つも無く、**6 本目の Server Action が
// `isSameOriginAction()` や `csrfTokenMatches` を書き忘れても lint・typecheck・全テスト・
// `gate:step5` がすべて緑のまま通る**状態だった（このリポジトリが繰り返し塞いできた
// 「書いたつもりが一度も確かめられていない」形）。
//
// **見るのは配線**（その名前を所有モジュールから取り込み、実際に呼んでいるか）で、順序や
// 引数の正しさではない。そこは個別の Server Action のテスト（`tests/agent-actions.test.ts` など）が
// 実際に呼んで固定する。配線だけでも、**新しく足した人が「守りを 1 つも書いていない」形**は落ちる。
import { describe, expect, it } from 'vitest';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { forEachNode, parseSourceFiles, resolveSourceSpecifier, SRC_DIR } from './lib/source-files';

// 画面の入口（この下の 'use server' ファイルが書き込みを受ける）
const APP_DIR = join(SRC_DIR, 'app');
// 守りの名前（所有モジュールと、そこから取り込むべき関数名）
const ORIGIN_GUARD = {
  module: join(SRC_DIR, 'lib', 'session-server.ts'),
  name: 'isSameOriginAction',
};
const CSRF_GUARD = { module: join(SRC_DIR, 'lib', 'csrf.ts'), name: 'csrfTokenMatches' };

// **CSRF トークンを要求できない経路**（理由付きの唯一の除外。キーは src からの相対パス）。
// ここに増える差分は理由の妥当性をレビューで必ず確認する
const CSRF_EXEMPT: Record<string, string> = {
  'app/login/actions.ts':
    'ログイン前はセッションが無く、トークンはセッションから導くので存在しない。' +
    'ログアウトも同じ経路にあるため同じ扱い。代わりに Origin の照合だけで守る（ADR-0011 決定 2）',
};

// そのファイルが 'use server' を宣言しているか（ファイル先頭のディレクティブ）
function isServerActionFile(source: ts.SourceFile): boolean {
  // 先頭から順に文を見る（ディレクティブは文字列リテラルの式文として現れる）
  for (const statement of source.statements) {
    // 式文でなければディレクティブ区間は終わり
    if (!ts.isExpressionStatement(statement)) continue;
    // 文字列リテラルでなければディレクティブではない
    if (!ts.isStringLiteral(statement.expression)) continue;
    // 探しているディレクティブ
    if (statement.expression.text === 'use server') return true;
  }
  return false;
}

// そのファイルが「どのモジュールから何という名前を取り込んでいるか」を集める
function namedImportsOf(parsed: { path: string; source: ts.SourceFile }): Map<string, Set<string>> {
  // モジュールの絶対パス → 取り込んだ名前
  const imports = new Map<string, Set<string>>();
  // 構文木を辿る
  forEachNode(parsed.source, (node) => {
    // 静的 import だけを見る（Server Action の守りは静的に取り込む）
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
    // 指定子を src 配下の絶対パスへ解決する（パッケージ名は null）
    const resolved = resolveSpecifier(parsed.path, node.moduleSpecifier.text);
    if (resolved === null) return;
    // 名前付きの取り込みだけを拾う（`import * as x` は名前が追えないので対象外）
    const bindings = node.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) return;
    // そのモジュールの集合へ足す
    const names = imports.get(resolved) ?? new Set<string>();
    for (const element of bindings.elements) names.add(element.name.text);
    imports.set(resolved, names);
  });
  return imports;
}

// import の指定子を解決する（`@/…` と相対のみ。source-files の規則をそのまま使う）
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  // 共有の解決規則を使う（写しを作らない）
  return resolveSourceSpecifier(fromFile, specifier);
}

// そのファイルの中で、その名前が**呼ばれている**か（`foo(...)` の形）
function callsName(scope: ts.Node, name: string): boolean {
  // 見つかったか
  let found = false;
  // 構文木を辿る
  forEachNode(scope, (node) => {
    // 呼び出し式で、呼ぶ対象がその識別子
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      found = true;
    }
  });
  return found;
}

// 1 つの Server Action（export された async 関数宣言）
interface ExportedAction {
  // 画面から呼ばれる名前（失敗の文言に出す）
  name: string;
  // 本体（この中に守りがあるかを見る）
  node: ts.FunctionDeclaration;
}

/**
 * そのファイルが export している**関数宣言**を集める。
 *
 * **ファイル単位で見てはいけない。** 1 つの `actions.ts` に 2 本目を足したとき、既にある
 * 1 本目が守りを呼んでいればファイル全体としては「呼んでいる」ことになり、新しいほうが
 * 丸腰でも素通りする（`src/app/login/actions.ts` が既に 2 本を export しているので、
 * 複数本を 1 ファイルに置くのはこのリポジトリの既定の形）。
 */
function exportedActionsOf(source: ts.SourceFile): ExportedAction[] {
  // 集めた関数
  const actions: ExportedAction[] = [];
  // ファイル直下の文だけを見る（Server Action は必ずトップレベルの export）
  for (const statement of source.statements) {
    // 関数宣言でなければ対象外
    if (!ts.isFunctionDeclaration(statement) || statement.name === undefined) continue;
    // export されていなければ外から呼べないので対象外
    const modifiers = ts.getModifiers(statement) ?? [];
    if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    // 本体を持たない宣言（オーバーロード）は対象外
    if (statement.body === undefined) continue;
    actions.push({ name: statement.name.text, node: statement });
  }
  return actions;
}

// src 配下の 'use server' ファイル（構文木つき）
const serverActionFiles = parseSourceFiles()
  .filter((parsed) => parsed.path.startsWith(APP_DIR) && isServerActionFile(parsed.source))
  .map((parsed) => ({ ...parsed, key: relative(SRC_DIR, parsed.path).split('\\').join('/') }));

// そのファイルたちが export している Server Action（**判定の単位は関数**）
const serverActions = serverActionFiles.flatMap((file) =>
  exportedActionsOf(file.source).map((action) => ({ ...action, file })),
);

describe('Server Action の守りの配線', () => {
  it('"use server" のファイルを 1 つ以上見つけられる（導出が空振りしていない）', () => {
    // 0 件なら「対象ゼロ＝緑」になるので fail-closed で落とす
    expect(serverActionFiles.length).toBeGreaterThan(0);
  });

  it('export された Server Action を 1 本以上見つけられる（関数の導出が空振りしていない）', () => {
    // ファイルは見つかるのに関数が 0 本なら、関数の導出のほうが壊れている（fail-closed）
    expect(serverActions.length).toBeGreaterThan(0);
  });

  it('すべての Server Action が Origin の照合を呼んでいる', () => {
    // 守りを呼んでいない**関数**（同じファイルの別の関数が呼んでいても数えない）
    const missing = serverActions.filter(
      (action) =>
        !(namedImportsOf(action.file).get(ORIGIN_GUARD.module)?.has(ORIGIN_GUARD.name) ?? false) ||
        !callsName(action.node, ORIGIN_GUARD.name),
    );
    // **他サイトのフォームから状態を変えられる形**なので、1 つでもあれば落とす
    expect(missing.map((action) => `${action.file.key}#${action.name}`)).toEqual([]);
  });

  it('CSRF トークンの照合を呼んでいる（除外は理由付きの表だけ）', () => {
    // 除外に載っていないのに照合を呼んでいない関数
    const missing = serverActions.filter(
      (action) =>
        !Object.hasOwn(CSRF_EXEMPT, action.file.key) &&
        (!(namedImportsOf(action.file).get(CSRF_GUARD.module)?.has(CSRF_GUARD.name) ?? false) ||
          !callsName(action.node, CSRF_GUARD.name)),
    );
    expect(missing.map((action) => `${action.file.key}#${action.name}`)).toEqual([]);
  });

  it('除外表のキーは実在し、理由が書かれている', () => {
    // 実在するファイルの一覧
    const known = new Set(serverActionFiles.map((file) => file.key));
    for (const [key, reason] of Object.entries(CSRF_EXEMPT)) {
      // 消えたファイルの除外が残っていれば、次に同じ名前を作った人へ黙って効いてしまう
      expect(known.has(key), `除外表の ${key} が実在しない`).toBe(true);
      // 理由が空なら「とりあえず黙らせる」使い方になる
      expect(reason.trim().length, `除外表の ${key} に理由が無い`).toBeGreaterThan(0);
    }
  });
});
