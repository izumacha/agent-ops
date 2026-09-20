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
import { basename, dirname, join, resolve } from 'node:path';
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
    // **取り込み元は絶対パスへ解決してから同定する。** 末尾が `lib/<名前>.mjs` かどうかで
    // 見ていたときは、`scripts/vendor/lib/contract-database.mjs` に常に null を返す囮を置いて
    // 取り込み先を差し替えるだけで、ベンチの専用 DB ガードを外せた (実測で 705 件すべて緑・
    // lint も tsc も 0。開発 DB を TRUNCATE できる状態になった)
    const resolved = resolve(dirname(path), statement.moduleSpecifier.text);
    // scripts/lib 配下でなければ共有モジュールではない
    if (dirname(resolved) !== join(SCRIPTS_DIR, 'lib') || !resolved.endsWith('.mjs')) continue;
    // ファイル名をキーにする
    const moduleName = basename(resolved);
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
    byModule.set(moduleName, [...(byModule.get(moduleName) ?? []), ...names]);
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
    // 呼び出しを数える。**メンバ式 (`fs.readFileSync(...)`) も `fs.readFileSync` という名前で数える** —
    // 素の識別子だけを見ていたときは、標準モジュールをメンバ経由で呼ぶだけで
    // 「実行ヘルパーしか呼んでいない」と判定され、判定をまるごと書き写したゲートが除外できた (実測)
    if (ts.isCallExpression(node)) {
      // 呼び出し先の名前 (素の識別子か、受け手が識別子のメンバ式だけを読む)
      const called = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) &&
            ts.isIdentifier(node.expression.expression)
          ? `${node.expression.expression.text}.${node.expression.name.text}`
          : null;
      // 読めた呼び出しだけを覚える
      if (called !== null) byScope.get(scope)?.push({ name: called, args: node.arguments });
    }
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
 * その名前が指定した共有モジュールから取り込まれ、かつ同名のローカル宣言に覆われていないか。
 * **名前の一致だけでは足りない** — 取り込みをやめて同名のローカル関数を宣言すると綴りは満たせる
 * (実測で 713 件すべて緑のまま、判定が常に空配列を返すゲートが通った)。
 * @param path 対象ファイルの絶対パス
 * @param source その構文木
 * @param moduleName 共有モジュールのファイル名
 * @param localName このファイルの中での名前
 * @returns 取り込み由来なら true
 */
function comesFromSharedModule(
  path: string,
  source: ts.SourceFile,
  moduleName: string,
  localName: string,
): boolean {
  // その共有モジュールから取り込んだ名前
  const imported = importedSharedNames(path).get(moduleName) ?? [];
  // 手元の名前として使われていなければ、指しているのは別物
  if (!imported.some((entry) => entry.local === localName)) return false;
  // 同名のローカル宣言で覆われていれば、指しているのはそちら
  return !locallyDeclaredNames(source).has(localName);
}

/**
 * モジュールのトップレベルに**式文として**置かれた呼び出しを集める。
 * **なぜ要るか**: 到達可能性は「呼び出しがどのスコープにあるか」しか見ないので、
 * `if (process.env.GATE_STRICT === '1') exitIfFailures(...)` のように**条件で囲む**だけで
 * 結線が実質外れる (実測で 705 件すべて緑・lint も 0)。結線は無条件に置かれていることまで求める。
 * @param source 構文木
 * @returns トップレベルの式文として呼ばれている呼び出し
 */
function topLevelStatementCalls(source: ts.SourceFile): CallSite[] {
  // 集めた呼び出し
  const calls: CallSite[] = [];
  // トップレベルの文を順に見る
  for (const statement of source.statements) {
    // 式文でなければ関係ない
    if (!ts.isExpressionStatement(statement)) continue;
    // その式が素の識別子への呼び出しであること
    const expression = statement.expression;
    if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) continue;
    // 名前と実引数を覚える
    calls.push({ name: expression.expression.text, args: expression.arguments });
  }
  // 集めた結果
  return calls;
}

/**
 * そのファイルが自分で宣言している名前を集める (関数・変数・クラス)。
 * 取り込んだはずの名前が**同名のローカル宣言で覆われて**いないかを見るために使う。
 * @param source 構文木
 * @returns 宣言された名前
 */
function locallyDeclaredNames(source: ts.SourceFile): Set<string> {
  // 宣言された名前
  const names = new Set<string>();
  // すべての節点を辿る
  const visit = (node: ts.Node): void => {
    // 関数宣言・クラス宣言の名前
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name !== undefined)
      names.add(node.name.text);
    // 変数宣言の名前 (素の識別子のみ)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) names.add(node.name.text);
    // 子を辿る
    ts.forEachChild(node, visit);
  };
  // 根から辿る
  ts.forEachChild(source, visit);
  // 集めた結果
  return names;
}

/**
 * そのファイルが取り込んでいるモジュールのうち、**`scripts/lib` 配下でないもの**を返す。
 * 静的 `import` だけでなく**動的 `import()` と `require()`** も見る — 静的 import しか
 * 見ていなかったときは、`const fs = await import('node:fs')` で標準モジュールを読み込み、
 * 判定をメンバ式呼び出しでインライン化したゲートが「共有モジュールしか取り込んでいない」と
 * 判定された (実測)。指定子は**絶対パスへ解決**して判定する (文字列一致だと `./vendor/lib/x.mjs`
 * のような囮パスが通る)
 * @param path 対象ファイルの絶対パス
 * @returns 共有モジュール以外の指定子 (重複なし)
 */
export function foreignModuleSpecifiers(path: string): string[] {
  // 構文木にする
  const source = parseScript(path);
  // 見つかった指定子
  const specifiers: string[] = [];
  // 取り込みの形ごとに指定子を拾う
  const visit = (node: ts.Node): void => {
    // 静的 import
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
      specifiers.push(node.moduleSpecifier.text);
    // 動的 import() と require()
    if (ts.isCallExpression(node)) {
      // 動的 import か require か
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      // 第 1 引数が文字列リテラルのときだけ読める
      const first = node.arguments[0];
      if ((isDynamicImport || isRequire) && first !== undefined && ts.isStringLiteral(first))
        specifiers.push(first.text);
    }
    // 子を辿る
    ts.forEachChild(node, visit);
  };
  // 根から辿る
  ts.forEachChild(source, visit);
  // scripts/lib 配下へ解決できないものだけを返す
  return [
    ...new Set(
      specifiers.filter((specifier) => {
        // 相対パスでなければ共有モジュールではない (node: や npm パッケージ)
        if (!specifier.startsWith('.')) return true;
        // 絶対パスへ解決して置き場を見る
        const resolved = resolve(dirname(path), specifier);
        return dirname(resolved) !== join(SCRIPTS_DIR, 'lib') || !resolved.endsWith('.mjs');
      }),
    ),
  ];
}

/**
 * トップレベルから到達できる位置で呼ばれている関数の名前をすべて返す
 * (素の識別子は `f`、受け手が識別子のメンバ式は `a.b` の形)。
 * 「このファイルは runSteps と banner しかしていない」のような**構造の主張**を確かめるために使う。
 * @param path 対象ファイルの絶対パス
 * @returns 呼び出し先の名前 (重複なし)
 */
export function reachableCallNames(path: string): string[] {
  // 構文木にする
  const source = parseScript(path);
  // スコープごとの呼び出し
  const byScope = collectCallsByScope(source);
  // 到達可能なスコープの呼び出し先を集める
  const names = [...reachableScopes(byScope)].flatMap((scope) =>
    (byScope.get(scope) ?? []).map((call) => call.name),
  );
  // 重複を潰して返す
  return [...new Set(names)];
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
 *
 * **逆向きの境界もある**: 名前が一致すれば「呼んでいる」と数えるので、取り込みをやめて
 * **同名のローカル関数**を宣言すれば綴りだけ満たせる (実測で 705 件すべて緑・件数も不変)。
 * これは緑側に倒れるので、結線を見張る用途では `importedFrom` を必ず渡すこと。
 * 同じ理由で、`false` を期待する検査 (「呼んでいないこと」の確認) にこの関数を単独で使わない —
 * 上の偽陰性がそのまま緑になる。取り込みの有無 (`importedSharedNames`) のように、
 * 偽陰性が赤側に出る手がかりと組み合わせる。
 * @param path 対象ファイルの絶対パス
 * @param functionName 呼び出し先の識別子
 * @param options 絞り込み。`atTopLevel` はモジュールのトップレベルに**式文として**置かれた
 *   呼び出しだけを数える (条件で囲む形を落とす)。`importedFrom` はその名前が
 *   `scripts/lib/<その名前>` から取り込まれ、かつ同名のローカル宣言で覆われていないことを求める
 *   (同名の no-op をその場で宣言して差し替える形を落とす)。`argument` はその位置の実引数が
 *   `callOf` に挙げた関数の**呼び出しそのもの**で、その関数もまた `importedFrom` 由来であることを求める
 * @returns 条件を満たす呼び出しがあれば true
 */
export function callsFunction(
  path: string,
  functionName: string,
  options: {
    atTopLevel?: boolean;
    importedFrom?: string;
    argument?: { index: number; callOf: readonly string[]; importedFrom: string };
  } = {},
): boolean {
  // 構文木にする
  const source = parseScript(path);
  // スコープごとの呼び出しを集める
  const byScope = collectCallsByScope(source);
  // **取り込み元まで確かめる。** 名前の一致だけを見ていたときは、import をやめて同名の
  // no-op をその場で宣言するだけで結線が消えた (実測で 705 件すべて緑・件数も不変)
  if (
    options.importedFrom !== undefined &&
    !comesFromSharedModule(path, source, options.importedFrom, functionName)
  )
    return false;
  // 見る呼び出しの集合 (トップレベルの式文に限るか、到達可能なスコープ全部か)
  const candidates =
    options.atTopLevel === true
      ? topLevelStatementCalls(source)
      : [...reachableScopes(byScope)].flatMap((scope) => byScope.get(scope) ?? []);
  // 順に見る
  for (const call of candidates) {
    // 名前が違えば関係ない
    if (call.name !== functionName) continue;
    // 引数の形を問わないならここで成立
    if (options.argument === undefined) return true;
    // 指定した位置の実引数
    const argument = call.args[options.argument.index];
    // **判定の呼び出しそのものであること**を求める。中間変数を許していたときは、宣言と
    // 呼び出しの間で再代入 (`failures = []`) や破壊的変更 (`failures.length = 0`) ができ、
    // どちらも検出網に 1 ビットも映らなかった (実測で 713 件すべて緑)
    if (argument === undefined || !ts.isCallExpression(argument)) continue;
    // 呼び出し先が素の識別子でなければ、判定だと確かめられない
    if (!ts.isIdentifier(argument.expression)) continue;
    // 判定の名前でなければ別物
    if (!options.argument.callOf.includes(argument.expression.text)) continue;
    // **判定そのものも共有モジュール由来であること**まで見る (同名のローカル no-op を落とす)
    if (
      !comesFromSharedModule(path, source, options.argument.importedFrom, argument.expression.text)
    )
      continue;
    // すべて満たした
    return true;
  }
  // 条件を満たす呼び出しは無い
  return false;
}
