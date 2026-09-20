// scripts/ 配下を「綴りではなく構文」で走査し、動的 import も 1 か所へ寄せるための共通部品。
//
// **なぜ構文で見るか**: 文字列一致 (`includes` / 正規表現) で「この関数を呼んでいるか」を見ると、
// **呼び出しを消してコメントに書き残すだけで満たされる**。実測で、ゲートの
// `exitIfFailures('gate:step2', failures);` を消して同じ式をコメントへ残す変異は
// 697 件すべて緑・件数も不変で通った (lint も `void failures;` を添えれば exit 0)。
// `tests/lib/source-files.ts` が src 向けに同じ理由で構文木を使っているので、流儀をそろえる。
//
// **なぜ import をここへ寄せるか**: `pathToFileURL(...).href` を渡す形を 2 つのテストが
// 書き写していた。片方だけ直されると検出網が静かに狭まる (§6 DRY)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// 走査の根 (ゲート・ベンチ・共有モジュールの置き場)
export const SCRIPTS_DIR = join(process.cwd(), 'scripts');

// ゲートスクリプトの名前 (Step ごとに 1 本)
export function gateScriptNames(): string[] {
  // 名前の付け方が唯一の手がかり (gate-step<数字>.mjs)
  return readdirSync(SCRIPTS_DIR).filter((name) => /^gate-step\d+\.mjs$/.test(name));
}

// scripts/lib 配下の共有モジュールの名前
export function sharedModuleNames(): string[] {
  // ESM だけを対象にする
  return readdirSync(join(SCRIPTS_DIR, 'lib')).filter((name) => name.endsWith('.mjs'));
}

/**
 * scripts/lib のモジュールを読み込む。
 * **相対パスのテンプレートで import しない** — vite が毎回「拡張子を静的部分に含めよ」と警告し、
 * 常態化した警告は本物の警告を埋める。ファイル URL を渡せば静かになる。
 * 読み込むモジュールは import しただけで副作用を持たないこと (ここが無関係に落ちなくなる)
 * @param name ファイル名 (sharedModuleNames が返すもの)
 * @returns そのモジュールの export
 */
export async function importSharedModule(name: string): Promise<Record<string, unknown>> {
  // ファイル URL に変換してから読み込む
  return (await import(pathToFileURL(join(SCRIPTS_DIR, 'lib', name)).href)) as Record<
    string,
    unknown
  >;
}

// ファイルを構文木にする (.mjs / .ts のどちらも JavaScript として読める範囲で足りる)
function parseScript(path: string): ts.SourceFile {
  // 位置情報つきで読む (setParentNodes = true)
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
}

// 取り込んだ名前 1 つぶん (別名で取り込んだ場合に備えて、export 側と手元の名前を分けて持つ)
export interface ImportedName {
  // モジュールが export している名前
  exported: string;
  // このファイルの中での名前 (呼び出しを探すときはこちら)
  local: string;
}

/**
 * そのファイルが `scripts/lib/*.mjs` から取り込んでいる名前を、モジュールごとに集める。
 * **文字列一致で「このモジュールを読んでいるか」を見ない** — コメントに綴りが出てくるだけの
 * ファイルまで対象に数えてしまい、逆に対象から外す変異には気付けない。
 * @param path 対象ファイルの絶対パス
 * @returns モジュールのファイル名 → 取り込んだ名前
 */
export function importedSharedNames(path: string): Map<string, ImportedName[]> {
  // 構文木にする
  const source = parseScript(path);
  // モジュールごとの取り込み
  const byModule = new Map<string, ImportedName[]>();
  // トップレベルの import 宣言だけを見る
  for (const statement of source.statements) {
    // import 宣言で、取り込み元が文字列リテラルのものだけ
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    // scripts/lib のモジュールかどうか (相対パスの末尾で判定する)
    const matched = /(?:^|\/)lib\/([\w.-]+\.mjs)$/.exec(statement.moduleSpecifier.text);
    // 違えば関係ない
    if (matched === null) continue;
    // 名前付き取り込み (`import { a, b as c } from ...`) だけを対象にする
    const bindings = statement.importClause?.namedBindings;
    // 名前付きでなければ名前を特定できない
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    // 取り込んだ名前を並べる (別名は propertyName に元の名前が入る)
    const names = bindings.elements.map((element) => ({
      exported: (element.propertyName ?? element.name).text,
      local: element.name.text,
    }));
    // 同じモジュールを複数回取り込んでいても 1 つにまとめる
    byModule.set(matched[1], [...(byModule.get(matched[1]) ?? []), ...names]);
  }
  // 集めた結果
  return byModule;
}

// モジュールのトップレベルを表すスコープ名 (識別子としては書けない綴りにして、関数名と衝突させない)
const TOP_LEVEL_SCOPE = '<トップレベル>';

// その節点が「名前の付いた関数の宣言」なら、その名前を返す (そうでなければ null)
function declaredFunctionName(node: ts.Node): string | null {
  // function f() {} の形
  if (ts.isFunctionDeclaration(node) && node.name !== undefined) return node.name.text;
  // const f = () => {} / const f = function () {} の形
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer !== undefined &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  )
    return node.name.text;
  // それ以外は名前が無い (呼び出しは外側のスコープに数える)
  return null;
}

// 呼び出し 1 件ぶんの情報 (名前と実引数)
interface CallSite {
  // 呼び出し先の識別子
  name: string;
  // 実引数の並び
  args: readonly ts.Expression[];
}

/**
 * ファイルを「トップレベル」と「名前付き関数ごと」のスコープに分け、各スコープの呼び出しを集める。
 * 名前の無い関数 (コールバック等) の中の呼び出しは、外側の名前付きスコープに数える。
 * @param source 構文木
 * @returns スコープ名 → そのスコープが行う呼び出し
 */
function collectCallsByScope(source: ts.SourceFile): Map<string, CallSite[]> {
  // スコープごとの呼び出し (トップレベルは必ず存在する)
  const byScope = new Map<string, CallSite[]>([[TOP_LEVEL_SCOPE, []]]);
  // 節点を辿る (いま居るスコープ名を持ち回る)
  const visit = (node: ts.Node, scope: string): void => {
    // 名前付き関数に入ったらスコープを切り替える
    const declared = declaredFunctionName(node);
    // 同じ名前の宣言が複数あっても 1 つのスコープにまとめる
    if (declared !== null && !byScope.has(declared)) byScope.set(declared, []);
    // 子を辿るときのスコープ
    const inner = declared ?? scope;
    // 素の識別子への呼び出しだけを数える (メンバ式・別名経由は捉えられない。下の注記を参照)
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression))
      byScope.get(scope)?.push({ name: node.expression.text, args: node.arguments });
    // 子を辿る
    ts.forEachChild(node, (child) => visit(child, inner));
  };
  // 根から辿る (根の直下がトップレベル)
  ts.forEachChild(source, (child) => visit(child, TOP_LEVEL_SCOPE));
  // 集めた結果
  return byScope;
}

/**
 * トップレベルから実際に呼ばれうるスコープの名前を求める (到達可能性)。
 * **なぜ要るか**: 「どこかに呼び出しがあるか」だけを見ると、**一度も呼ばれない関数の中へ
 * 移すだけ**で満たせてしまう。実測で、ゲートの `exitIfFailures(...)` を
 * `function neverCalledReporter() { … }` の中へ移し `void neverCalledReporter;` を添える変異は
 * 45 件すべて緑・`npm run lint` も exit 0 で通った (未使用にならないため eslint にも映らない)。
 * @param byScope collectCallsByScope の結果
 * @returns 到達可能なスコープ名の集合
 */
function reachableScopes(byScope: Map<string, CallSite[]>): Set<string> {
  // トップレベルは必ず実行される
  const reachable = new Set<string>([TOP_LEVEL_SCOPE]);
  // 辿る先の待ち行列
  const queue: string[] = [TOP_LEVEL_SCOPE];
  // 呼び出しを辿って広げる (不動点まで)
  while (queue.length > 0) {
    // 次に見るスコープ
    const current = queue.pop() as string;
    for (const call of byScope.get(current) ?? []) {
      // 呼び出し先がこのファイルの名前付き関数で、まだ辿っていなければ広げる
      if (byScope.has(call.name) && !reachable.has(call.name)) {
        reachable.add(call.name);
        queue.push(call.name);
      }
    }
  }
  // 到達可能なスコープ
  return reachable;
}

/**
 * そのファイルが、指定した名前の関数を**実際に呼んでいる**かを構文木で確かめる。
 * コメント・文字列リテラルの中の記述はトークンにならないので数えない。
 * **トップレベルから到達できる位置からの呼び出しだけを数える** (死んだコードの中の呼び出しは数えない)。
 *
 * **捉えられない形 (残る境界)**: 別名で import した呼び出し (`import { f as g }` → `g()`)、
 * 名前空間経由 (`lib.f()`)、変数へ入れてからの呼び出し (`const f2 = f; f2()`)、
 * メソッドとして保持された関数。いずれも「呼び出し先が素の識別子」という手がかりから外れる。
 * これらは**呼んでいるのに false になる**側 (＝赤くなる側) なので、静かに緩む向きには倒れない。
 * @param path 対象ファイルの絶対パス
 * @param functionName 呼び出し先の識別子
 * @param options identifierArgument を渡すと、その位置の実引数が**素の識別子**である呼び出しだけを数える
 * @returns 条件を満たす呼び出しがあれば true
 */
export function callsFunction(
  path: string,
  functionName: string,
  options: { identifierArgument?: number } = {},
): boolean {
  // 構文木にする
  const source = parseScript(path);
  // スコープごとの呼び出しを集める
  const byScope = collectCallsByScope(source);
  // トップレベルから到達できるスコープだけを見る
  const reachable = reachableScopes(byScope);
  // 到達可能なスコープの呼び出しを順に見る
  for (const scope of reachable) {
    for (const call of byScope.get(scope) ?? []) {
      // 名前が違えば関係ない
      if (call.name !== functionName) continue;
      // 引数の形を問わないならここで成立
      if (options.identifierArgument === undefined) return true;
      // 指定した位置の実引数
      const argument = call.args[options.identifierArgument];
      // **素の識別子であること**まで見る。式を許すと、渡す値そのものを無害化する変異
      // (`exitIfFailures('gate:step2', failures.filter(() => false))`) が素通りする (実測)
      if (argument !== undefined && ts.isIdentifier(argument)) return true;
    }
  }
  // 条件を満たす呼び出しは無い
  return false;
}
