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

/**
 * そのディレクトリ配下の ESM を、**入れ子も含めて**相対パスで返す。
 * **1 段だけ読むと、許可の範囲より走査の範囲が狭くなる** — import の許可は
 * `scripts/lib/` の**前方一致**なので `./lib/sub/preflight.mjs` を通すのに、
 * 走査が直下 1 段だとそのファイルを 1 度も見なかった。実測で、そこへ `process.exit(0)` を
 * 置いて `require-contract-env.mjs` から取り込むと、ガードが 1 件も検証せず exit 0 になり
 * 807 件すべて緑 (件数も不変) だった
 * @param directory 走査するディレクトリの絶対パス
 * @returns ディレクトリからの相対パス (重複なし)
 */
function esmNamesUnder(directory: string): string[] {
  // 入れ子まで辿って ESM だけを残す
  return readdirSync(directory, { recursive: true })
    .map((entry) => String(entry))
    .filter((name) => name.endsWith('.mjs'));
}

/**
 * `scripts/` 配下の ESM の絶対パスをすべて返す（入れ子も含む）。
 * **綴りで対象を絞らない** — ゲート (`gate-step<数字>.mjs`) と共有モジュール (`lib/`) だけを
 * 見ていたときは、`require-contract-env.mjs`（契約テストの入口ガード）がどの許可リストの
 * 対象にもならず、先頭に `process.exit(0)` を足すだけで「1 件も検証していないのに緑」に
 * できた（実測で 798 件すべて緑）。役割ではなく「そこにある実行されるファイル」で選ぶ
 * @returns ESM の絶対パス（重複なし）
 */
export function scriptModulePaths(): string[] {
  // 入れ子まで含めた .mjs を絶対パスにする
  return esmNamesUnder(SCRIPTS_DIR).map((name) => join(SCRIPTS_DIR, name));
}

// scripts/lib 配下の共有モジュールの名前 (入れ子も含む。理由は esmNamesUnder のコメント)
export function sharedModuleNames(): string[] {
  // ESM だけを対象にする
  return esmNamesUnder(join(SCRIPTS_DIR, 'lib'));
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
  // **別名での取り込みを許さない。** 手元の名前だけを見ていたときは
  // `import { evaluateStep1Report as evaluateStep2Report }` と 1 行書き換えるだけで
  // 「共有モジュール由来」と判定され、中身が別物でも綴りだけで通った (実測で 722 件すべて緑・
  // 件数も不変)。同じ手口で `banner as exitIfFailures` はゲートの非 0 終了を消し、
  // `contractDatabaseProblem as requireContractDatabase` はベンチの専用 DB ガードを
  // no-op にできた (どちらも実測)。export 側の名前と手元の名前が一致することまで求める
  if (!imported.some((entry) => entry.local === localName && entry.exported === localName))
    return false;
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
 * モジュールのトップレベルに**式文として**置かれた呼び出しの名前を、現れる順に返す。
 * 「何を、どの順で、いくつ実行しているか」をそのまま読めるので、呼び出しの有無だけでなく
 * **順番** (専用 DB のガードが計測より前にあるか) や**余計な実行**の有無も突き合わせられる。
 * @param path 対象ファイルの絶対パス
 * @returns 呼び出し先の名前 (現れる順)
 */
export function topLevelCallNames(path: string): string[] {
  // トップレベルの式文の呼び出しから名前だけを取り出す
  return topLevelStatementCalls(parseScript(path)).map((call) => call.name);
}

// グローバルオブジェクトを指す識別子 (この経由でも `process` へ届く)
const GLOBAL_OBJECT_NAMES = new Set(['globalThis', 'global']);

// 中身を静的に追えない組み込み (文字列からコードを作るので、名前だけでは何をするか分からない)
const OPAQUE_GLOBAL_NAMES = new Set(['eval', 'Function']);

/**
 * その識別子が「宣言している名前」か (`function eval() {}` / `const Function = …` / 引数名)。
 * **宣言は参照ではない** — 数えると、無関係な名前を宣言しただけで直しようのない赤になる
 */
function isDeclarationName(node: ts.Identifier): boolean {
  // 親の節点
  const parent = node.parent;
  // 親が無ければ宣言ではない
  if (parent === undefined) return false;
  // 宣言の名前の位置にいるか (変数・関数・引数・クラス)
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isClassDeclaration(parent)) &&
    parent.name === node
  )
    return true;
  // 分割代入の要素 (`const { eval: x } = o` の `eval` はプロパティ名、`x` は束縛する名前)
  if (ts.isBindingElement(parent)) return parent.name === node || parent.propertyName === node;
  // import で束縛する名前
  return ts.isImportSpecifier(parent) || ts.isImportClause(parent);
}

/**
 * その式が `process` オブジェクトを指しているか (素の `process`・`globalThis.process`・
 * `globalThis['process']`)。
 * **前置きを 1 か所で剥がすのが要点** — 素の識別子だけを見ていたときは `globalThis.` を
 * 足すだけで `processUses` からも `processExitArguments` からも同時に消え、ゲート全体を
 * 無言の no-op にできた (実測で 798 件すべて緑・件数も不変)。
 *
 * **ただしここは綴りを並べる側なので、これだけでは閉じない** — 実測で
 * `globalThis['process'].exit(0)` は要素アクセスを見ていなかったため、
 * `const g = globalThis; g.process.exit(0)` は前置きの識別子を 2 語に決め打ちしていたため、
 * どちらも 807 件すべて緑のまま (件数も不変) ゲートを無言の no-op にできた。前者はここで
 * 綴りを 1 つ足して閉じるが、後者のような**次の変種は綴りを増やしても追いつかない**ので、
 * `processUses` 側が「グローバルオブジェクトが土台以外に現れたこと」自体を使い方として数える
 */
function isProcessObject(node: ts.Expression): boolean {
  // 素の `process`
  if (ts.isIdentifier(node) && node.text === 'process') return true;
  // `globalThis.process` / `global.process`
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    GLOBAL_OBJECT_NAMES.has(node.expression.text) &&
    node.name.text === 'process'
  )
    return true;
  // `globalThis['process']` / `global['process']` (添字が文字列リテラルの形)
  return (
    ts.isElementAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    GLOBAL_OBJECT_NAMES.has(node.expression.text) &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    node.argumentExpression.text === 'process'
  );
}

/**
 * その識別子が「値ではなく名前」として書かれているか
 * (`x.foo` のプロパティ名・`{ foo: 1 }` のキー)。
 * **参照ではないので使い方に数えない** — 数えると無関係な項目名で直しようのない赤になる
 */
function isWrittenAsName(node: ts.Identifier): boolean {
  // 親の節点
  const parent = node.parent;
  // 親が無ければ名前ではない
  if (parent === undefined) return false;
  // `x.foo` の `foo` か `{ foo: 1 }` の `foo` か
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node)
  );
}

/**
 * その識別子から先を**静的に追えるか**（追えるなら、そこ自体は使い方に数えなくてよい）。
 *
 * **「プロパティを取り出す土台なら追える」は誤り。** 追えるのは `<globalThis>.process` の
 * **1 ホップだけ**なので、土台であることを無条件に免除すると次の 2 系統が誰にも見えなくなる
 * （どちらも実測で 808 件すべて緑・件数も不変のままゲートを無言の no-op にできた）:
 * - `globalThis.globalThis.process.exit(0)` — `globalThis.globalThis === globalThis` なので動く。
 *   先頭は「土台」、2 つ目と `process` は「名前」、外側の式は `isProcessObject` が読めない。
 * - `const k = 'process'; globalThis[k].exit(0)` — 添字が静的に読めない。
 *
 * そこで**免除する条件を「その先が読めたこと」に変える**: その access が `process` として
 * 読めるか、あるいは**そこで行き止まり**（さらに辿ったり呼んだりしていない）なら免除し、
 * それ以外は「追えなくなった地点」として呼び出し側が数える。
 * 行き止まりを免除に含めるのは `globalThis[MARKER] = true`（印を立てる書き込み。
 * `scripts/lib/contract-database.mjs`）のためで、書き込みからは `process` へ手が伸びない
 */
function isStaticallyFollowedGlobal(node: ts.Identifier): boolean {
  // 親の節点
  const parent = node.parent;
  // 親が無ければ追う先も無い
  if (parent === undefined) return false;
  // `<node>.x` か `<node>[...]` の左側でなければ、値として使われている (追えない)
  if (
    !(ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) ||
    parent.expression !== node
  )
    return false;
  // その access が `process` として読めるなら、外側の判定が拾う
  if (isProcessObject(parent)) return true;
  // 読めなかった access の外側
  const outer = parent.parent;
  // **免除するのは「書き込みの左辺」だけ。** 値がそこから外へ出ない唯一の形で、
  // 現在の正当な用途 (`globalThis[MARKER] = true` の印) がこれにあたる。
  // **「さらに辿る・呼ぶ形でなければ免除」にしてはいけない** — 値は変数宣言・括弧・実引数など
  // あらゆる式の文脈から外へ出られるので、間に `const` を 1 つ置くだけで免除された
  // (実測: `const R = globalThis.globalThis; R.process.exit(0);` は 811 件すべて緑・件数も不変の
  // ままゲートを無言で exit 0 にできた。`const EV = globalThis.eval; EV('…')` も同じ形で
  // `eval` の検出を迂回した)。免除の条件そのものが「親の形」の列挙になっていたのが誤り
  return (
    outer !== undefined &&
    ts.isBinaryExpression(outer) &&
    outer.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    outer.left === parent
  );
}

/**
 * そのファイルにある `process.exit(...)` の実引数を、書かれた順に返す。
 * 数値リテラルはその値、それ以外 (変数・式・省略) は `'<非リテラル>'`。
 * **なぜ要るか**: ゲートは正当に `process.exit(1)` を使うので `process` の使用そのものは禁じられない。
 * 一方で `process.exit(0)` を 1 行足すだけでゲート全体が無言で成功終了する (実測で 779 件すべて緑・
 * CI の gate ジョブも緑のまま、Step0〜Step2 の全基準が一度も走らない)。**非 0 だけを許す**
 * @param path 対象ファイルの絶対パス
 * @returns 実引数の一覧 (書かれた順)
 */
export function processExitArguments(path: string): string[] {
  // 構文木にする
  const source = parseScript(path);
  // 見つかった実引数
  const found: string[] = [];
  // すべての節点を辿る
  const visit = (node: ts.Node): void => {
    // `process.exit(...)` の形だけを見る
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      isProcessObject(node.expression.expression) &&
      node.expression.name.text === 'exit'
    ) {
      // 第 1 引数 (省略されていれば 0 と同じ意味になる)
      const argument = node.arguments[0];
      found.push(
        argument !== undefined && ts.isNumericLiteral(argument) ? argument.text : '<非リテラル>',
      );
    }
    // 子を辿る
    ts.forEachChild(node, visit);
  };
  // 根から辿る
  ts.forEachChild(source, visit);
  // 集めた結果
  return found;
}

/**
 * モジュールのトップレベルに**式文として**置かれた呼び出しの、実引数の形を返す。
 * 形は `literal`（文字列・数値などのリテラル）/ `identifier`（素の識別子）/ `other`（それ以外）。
 * **なぜ要るか**: 実引数は呼び出しより先に評価されるので、`requireContractDatabase(f())` の
 * ように式を置けば、fail-closed のガードより前に必ず任意のコードが走る。実測で、同期に
 * ファイルを書く関数を実引数に置いた変異は 773 件すべて緑のまま、ガードより前に実行された
 * @param path 対象ファイルの絶対パス
 * @returns 呼び出しごとの名前と実引数の形 (現れる順)
 */
export function topLevelCallArgumentKinds(path: string): { name: string; kinds: string[] }[] {
  // トップレベルの式文の呼び出しを順に見る
  return topLevelStatementCalls(parseScript(path)).map((call) => ({
    name: call.name,
    // 実引数の形を判定する
    kinds: call.args.map((argument) => {
      // 文字列・数値・真偽値などのリテラル
      if (
        ts.isStringLiteral(argument) ||
        ts.isNumericLiteral(argument) ||
        argument.kind === ts.SyntaxKind.TrueKeyword ||
        argument.kind === ts.SyntaxKind.FalseKeyword
      )
        return 'literal';
      // 素の識別子 (関数を渡す形)
      if (ts.isIdentifier(argument)) return 'identifier';
      // それ以外 (呼び出し・三項・テンプレート…) は実行を伴いうる
      return 'other';
    }),
  }));
}

/**
 * モジュールのトップレベルに並ぶ文の種類を、現れる順に返す (構文木の種類名)。
 * **なぜ要るか**: 「トップレベルの式文として呼んでいる」だけを見ていると、その**手前**に
 * `if (!process.env.BENCH_STRICT) process.exit(0);` を 1 行足すだけで、呼び出しは残したまま
 * 一度も実行されない状態が作れる (実測で全件緑・件数も不変・出力も無しで exit 0)。
 * 個々の抜け道を綴りで追うと 1 つ漏らすたびに静かな穴になるので、**許す種類の側を列挙する**
 * (条件・繰り返し・try・ラベル文はどれも「その種類ではない」という 1 つの理由で落ちる)。
 * @param path 対象ファイルの絶対パス
 * @returns トップレベルの文の種類名 (現れる順)
 */
export function topLevelStatementKinds(path: string): string[] {
  // 構文木にして、根の直下の文の種類名を並べる
  return parseScript(path).statements.map((statement) => {
    // **`ts.SyntaxKind[kind]` の逆引きをそのまま使わない** — 同じ数値に複数の名前が割り当てられて
    // いるため、変数宣言の文が `FirstStatement` という別名で返る (実測)。判定に使う名前は述語から取る
    if (ts.isImportDeclaration(statement)) return 'ImportDeclaration';
    if (ts.isVariableStatement(statement)) return 'VariableStatement';
    if (ts.isFunctionDeclaration(statement)) return 'FunctionDeclaration';
    if (ts.isInterfaceDeclaration(statement)) return 'InterfaceDeclaration';
    if (ts.isTypeAliasDeclaration(statement)) return 'TypeAliasDeclaration';
    if (ts.isExpressionStatement(statement)) return 'ExpressionStatement';
    // 上に無い種類は逆引きの名前で返す (呼び出し側が許可リストで落とす)
    return ts.SyntaxKind[statement.kind];
  });
}

/**
 * そのファイルが `process` をどう使っているかを列挙する。
 * 素直な `process.<名前>` は `process.<名前>`、それ以外の形 (要素アクセス `process['exitCode']`・
 * 別名への束縛 `const p = process`・引数として渡す `Object.defineProperty(process, …)`) は
 * まとめて `process` として返す。**呼び出し側は「許してよい形」の許可リストで判定する。**
 *
 * **なぜ禁じたい名前を並べないか**: 以前は `exit` / `abort` / `exitCode` の 3 つだけを見ていたが、
 * これは綴りを追う形なので抜け道が残った。実測で、ベンチのトップレベルに
 * `const EXIT_HOOK = process.on('exit', () => { const runtime = process; runtime['exitCode'] = 0; });`
 * を 1 行足すと、**受け入れ基準を満たさなくても exit 0** になるのに検出網は全件緑
 * (749 passed・件数も不変・lint 0・tsc 0) だった。ゲートは終了コードしか見ないので Step2 が緑で通る。
 * 許す側を列挙すれば、`on` も要素アクセスも別名束縛も「許可リストに無い」という 1 つの理由で落ちる
 * @param path 対象ファイルの絶対パス
 * @returns 使い方の一覧 (重複なし)
 */
export function processUses(path: string): string[] {
  // 構文木にする
  const source = parseScript(path);
  // 見つかった使い方
  const found = new Set<string>();
  // すべての節点を辿る
  const visit = (node: ts.Node): void => {
    // **グローバルオブジェクトから先を静的に追えなくなったら、その地点自体を使い方に数える** —
    // 綴りを 1 つずつ潰す形では追いつかない (`const g = globalThis; g.process.exit(0)` /
    // `globalThis.globalThis.process.exit(0)` / `const k = 'process'; globalThis[k].exit(0)` は
    // いずれも実測で全件緑・件数も不変のままゲートを無言の no-op にできた)。
    // 「追えたか」の判定は `isStaticallyFollowedGlobal` が持つ。**追えない形は許可リストに
    // 無い名前として落ちる**ので、次の変種が出ても同じ 1 つの理由で止まる
    if (
      ts.isIdentifier(node) &&
      GLOBAL_OBJECT_NAMES.has(node.text) &&
      !isStaticallyFollowedGlobal(node) &&
      !isWrittenAsName(node)
    )
      found.add('globalThis');
    // **`.constructor` も不透明なホップ** — `[].constructor.constructor('process.exit(0)')()` は
    // `Function` を名指しせずに同じことをするので、名前の一覧では捉えられない
    // (実測で 4 形すべて 811 件緑のままゲートを無言で exit 0 にでき、ベンチでは偽の合格 payload を
    // 出して受け入れ基準を通せた)。`scripts/` 配下に `constructor` の出現は 0 件なので誤検知は無い
    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === 'constructor') ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === 'constructor')
    )
      found.add('constructor');
    // **静的解析がそこで途切れる組み込みも同じ扱い** — `eval('process.exit(0)')` や
    // `new Function('return process')().exit(0)` は名前としては見えるのに中身を追えない。
    // **残る境界**: 同名のローカル束縛への参照 (`catch (Function) { return Function; }`) も
    // ここでは数える (宣言そのものは除くが、参照までは区別しない)。現在そう書いた箇所は無く、
    // 出たときは名前を変えれば済む。**綴りが静的に現れない形は原理的に捉えられない** —
    // 実測した例: `Reflect.get(function(){}, 'constructor')('…')()` /
    // `[]['con' + 'structor']['con' + 'structor']('…')()` /
    // `Object.getOwnPropertyDescriptor(Object.getPrototypeOf(()=>{}), 'constructor').value('…')()`。
    // **この系統はゲートの挙動検査 (子プロセスで実際に走らせる 2 本) が受け持つ**
    if (
      ts.isIdentifier(node) &&
      OPAQUE_GLOBAL_NAMES.has(node.text) &&
      !isWrittenAsName(node) &&
      !isDeclarationName(node)
    )
      found.add(node.text);
    // `process` オブジェクトを指す式だけを見る (素の `process` と `globalThis.process`)
    if (ts.isExpression(node) && isProcessObject(node)) {
      // 親の節点 (どう使われているかを知るため)
      const parent = node.parent;
      // **`globalThis.process` の中の `process` は「名前」なので、外側の式だけを数える**
      // (内側まで数えると同じ 1 か所が 2 件に見える)
      if (ts.isIdentifier(node) && parent !== undefined && isProcessObject(parent as ts.Expression))
        return;
      // **「名前として書かれただけ」は参照ではない** — `x.process` のプロパティ名や
      // `{ process: 'x' }` のキーまで数えると、無関係な項目名で直しようのない赤になる
      const isName = ts.isIdentifier(node) && isWrittenAsName(node);
      // 親が `<process>.<名前>` の形で、自分がその受け手なら、その名前まで含めて覚える
      if (
        parent !== undefined &&
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node
      ) {
        // 取り出している名前
        const member = parent.name.text;
        // その場で呼んでいるか (`<process>.<名前>(…)` の callee の位置にいるか)
        const calledHere =
          parent.parent !== undefined &&
          ts.isCallExpression(parent.parent) &&
          parent.parent.expression === parent;
        // **`process.exit` を取り出しただけの形は実引数が見えない** — 実引数を非 0 に縛る
        // `processExitArguments` は「その場で呼ぶ」形しか読まないので、`process.exit.call(null, 0)` /
        // `.apply` / `.bind(null,0)()` / `Reflect.apply(process.exit, …)` / `const e = process.exit`
        // はどれも `process.exit`（許可済み）に見えたまま実引数の検査を素通りした
        // (実測で 808 件すべて緑・件数も不変のままゲートが無言で exit 0 になった)。
        // 呼ばずに取り出した時点を別の使い方として数え、許可リストに無い名前として落とす
        found.add(member === 'exit' && !calledHere ? 'process.exit<間接>' : `process.${member}`);
      }
      // それ以外の形 (要素アクセス・別名束縛・引数渡し) は素の `process` として覚える
      else if (!isName) found.add('process');
    }
    // 子を辿る
    ts.forEachChild(node, visit);
  };
  // 根から辿る
  ts.forEachChild(source, visit);
  // 集めた結果
  return [...found];
}

/**
 * モジュールのトップレベルの**変数宣言の初期化子**が起こしうる作用を列挙する。
 * 呼び出しは名前 (`f` / `a.b`)、`await` は `'await'` として返す。
 *
 * **なぜ要るか**: トップレベルの文の種類だけを許可リストで縛っても、`VariableStatement` は
 * 宣言のために許すしかなく、その**初期化子の中は視界の外**だった。実測で、ベンチの
 * トップレベルに `const CLEARED = await CLIENT.$executeRaw\`TRUNCATE TABLE "Tenant" CASCADE\`;`
 * を専用 DB のガードより前へ置くと、検出網は全件緑 (749 passed・件数も不変) のまま、
 * ガードが約束している「1 件も書かずに止める」が破れて**開発 DB を空にしてから**落ちた。
 * 初期化子で計算してよいのは定数だけなので、呼び出し先を許可リストで縛る
 * @param path 対象ファイルの絶対パス
 * @returns 呼び出し先の名前と `'await'` (重複なし)
 */
export function topLevelInitializerEffects(path: string): string[] {
  // 構文木にする
  const source = parseScript(path);
  // 見つかった作用
  const found = new Set<string>();
  // 初期化子の中を辿る
  const visit = (node: ts.Node): void => {
    // **関数の本体へは降りない** — 宣言しただけでは実行されないので、降りると普通のヘルパーを
    // 置くたびに許可リストへの追加を強いられ、その名前が「本当のトップレベルの副作用」としても
    // 許される (許可リストが緩む圧力になる)。呼ばれる側の本体は残る境界として受け入れる
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isFunctionDeclaration(node))
      return;
    // 呼び出しは呼び出し先の名前で覚える (読めない形は `<other>` として落とす)
    if (ts.isCallExpression(node)) {
      // 素の識別子か、受け手が識別子のメンバ式だけ名前として読める
      found.add(
        ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression) &&
              ts.isIdentifier(node.expression.expression)
            ? `${node.expression.expression.text}.${node.expression.name.text}`
            : '<other>',
      );
    }
    // トップレベル await は「何でも起こせる」ので独立した作用として覚える
    if (ts.isAwaitExpression(node)) found.add('await');
    // タグ付きテンプレート (生 SQL がこの形) も呼び出しとして覚える
    if (ts.isTaggedTemplateExpression(node)) found.add('<tagged-template>');
    // 子を辿る
    ts.forEachChild(node, visit);
  };
  // トップレベルの変数宣言だけを対象にする
  for (const statement of source.statements)
    if (ts.isVariableStatement(statement)) ts.forEachChild(statement, visit);
  // 集めた結果
  return [...found];
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
      // 第 1 引数 (取り込む先)
      const first = node.arguments[0];
      // **読めない指定子を「無かったこと」にしない** — リテラルのときだけ記録していた版では、
      // `await import('./preflight' + '.js')` と 1 文字足すだけでその import が判定の視界から
      // 消え、許可リストの検査が「取り込みは 0 件」として緑になった (実測で 811 件すべて緑・
      // 件数も不変のままゲートが無言で exit 0)。走査と許可の不等号ではなく「どちらにも現れない」
      // 形なので、集合の導出をどう直しても届かない。読めないことを名前として残して落とす
      if (isDynamicImport || isRequire)
        specifiers.push(
          first !== undefined && ts.isStringLiteral(first) ? first.text : '<読めない指定子>',
        );
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
// npm を起動する実行ヘルパーの名前 (この第 1 引数だけを「npm へ渡す引数」として読む)
const NPM_RUNNER_NAMES = new Set(['runNpm', 'runNpmCapturingStdout']);

/**
 * `scripts/` にある `gate-step<N>.mjs` のうち、**N がいちばん大きいもの**の名前を返す。
 * **綴りを固定しない** — 次の Step のゲートが増えた瞬間、綴り固定の検査は古いゲートを
 * 見続けたまま緑になる（新しいゲートが何を流さなくても気付けない）
 * @returns ゲートのファイル名
 */
export function latestGateScriptName(): string {
  // ゲートの一覧から N を取り出す
  const numbers = gateScriptNames()
    .map((name) => /^gate-step(\d+)\.mjs$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));
  // 1 つも無ければ導出が壊れている (fail-closed)
  if (numbers.length === 0) throw new Error('scripts/ に gate-stepN.mjs が無い');
  // いちばん大きい N のゲート
  return `gate-step${Math.max(...numbers)}.mjs`;
}

/**
 * そのファイルが **`npm` に渡している引数の配列**から、サブコマンド名を集める。
 * `['run', '<スクリプト>']` なら `<スクリプト>`、`['audit', …]` なら `'audit'`。
 *
 * **なぜ要るか**: ゲートを実際に走らせて「呼ばれた npm」を数えるだけでは、**呼ばれなかった
 * ことを検出できない** — 途中で黙って終わる変異は呼び出しの一覧ごと縮むので、その一覧から
 * 検査対象を導くと検査も一緒に縮む（実測で、判定の直後に終了を置く変異が全件緑で通った）。
 * ソースから「流すと書いてあるもの」を別に導いて、実際に流したものと突き合わせる
 * @param path 対象ファイルの絶対パス
 * @returns サブコマンド名 (重複なし・書かれた順)
 */
export function npmInvocationsInSource(path: string): string[] {
  // 構文木にする
  const source = parseScript(path);
  // 見つかったサブコマンド
  const found = new Set<string>();
  // その配列リテラルが「npm へ渡す引数」の位置にいるか
  //  - `runNpm([...])` / `runNpmCapturingStdout([...])` の第 1 引数
  //  - `{ name: '…', args: [...] }` の `args`
  // **どこにある配列でも拾ってはいけない** — 実測で、無害な `const TITLES = ['日次集計', …];`
  // を足すだけで「日次集計 を流していない」という読み取れない理由で赤くなった。
  // 正当なコードを直しようの無い文言で落とす網は、いずれ緩められる (この repo が繰り返し避けてきた形)
  const isNpmArgumentPosition = (node: ts.ArrayLiteralExpression): boolean => {
    // 親の節点
    const parent = node.parent;
    // 親が無ければ引数ではない
    if (parent === undefined) return false;
    // `args: [...]` の値
    if (ts.isPropertyAssignment(parent))
      return ts.isIdentifier(parent.name) && parent.name.text === 'args';
    // 実行ヘルパーの第 1 引数
    return (
      ts.isCallExpression(parent) &&
      parent.arguments[0] === node &&
      ts.isIdentifier(parent.expression) &&
      NPM_RUNNER_NAMES.has(parent.expression.text)
    );
  };
  // すべての節点を辿る
  const visit = (node: ts.Node): void => {
    // npm へ渡す引数の位置にある配列だけを見る
    if (ts.isArrayLiteralExpression(node) && isNpmArgumentPosition(node)) {
      // 先頭の要素
      const first = node.elements[0];
      // 先頭が文字列リテラルのときだけ見る
      if (first !== undefined && ts.isStringLiteralLike(first)) {
        // `['run', '<スクリプト>']` の形
        const second = node.elements[1];
        if (first.text === 'run' && second !== undefined && ts.isStringLiteralLike(second))
          found.add(second.text);
        // `['audit', …]` のように run 以外を直接渡す形
        else if (first.text !== 'run') found.add(first.text);
      }
    }
    // 子を辿る
    ts.forEachChild(node, visit);
  };
  // 根から辿る
  ts.forEachChild(source, visit);
  // 集めた結果
  return [...found];
}

export function reachableCallNames(path: string): string[] {
  // **名前の取れない呼び出しは一覧に現れない** — callee が計算式のとき
  // (`[]['con' + 'structor'](…)`) は名前が無いので丸ごと落ちる。呼び出し名の許可リストを
  // 掛ける側は、**件数**も併せて見ないと同じ穴がそこに開く (ベンチはトップレベルの
  // 式文の件数を固定しているのでそこは塞がっている)
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
 * そのテストファイルが `describe('<名前>', …)` として宣言し、**中に it を 1 件以上持つ**名前を返す。
 * **文字列の部分一致で見ない** — コメントに綴りを書き残すだけで満たせてしまい、
 * 判定の本体を `return null` にしても赤が 1 件も出なかった (実測。痕跡は件数の減少だけ)。
 * @param path 対象ファイルの絶対パス
 * @returns 中身のある describe の名前
 */
export function describedNamesWithTests(path: string): string[] {
  // 構文木にする
  const source = parseScript(path);
  // 見つかった名前
  const names: string[] = [];
  // その節点の下に it / it.each の呼び出しがあるか
  const hasTest = (node: ts.Node): boolean => {
    // 見つかったか
    let found = false;
    // 辿る
    const look = (current: ts.Node): void => {
      // 呼び出し式で、呼び出し先が `it` か `it.<何か>` なら該当
      if (ts.isCallExpression(current)) {
        // 素の `it(...)`
        const direct = ts.isIdentifier(current.expression) && current.expression.text === 'it';
        // `it.each(...)(...)` のような形 (受け手が it)
        const member =
          ts.isPropertyAccessExpression(current.expression) &&
          ts.isIdentifier(current.expression.expression) &&
          current.expression.expression.text === 'it';
        // どちらかなら該当
        if (direct || member) found = true;
      }
      // 子を辿る
      ts.forEachChild(current, look);
    };
    // 根から辿る
    look(node);
    // 結果
    return found;
  };
  // すべての節点から describe の呼び出しを探す
  const visit = (node: ts.Node): void => {
    // describe の呼び出しで、第 1 引数が文字列リテラルのものだけを見る
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'describe' &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      // 本体に it があるときだけ名前を数える (空の describe で満たせないように)
      const body = node.arguments[1];
      if (body !== undefined && hasTest(body)) names.push(node.arguments[0].text);
    }
    // 子を辿る
    ts.forEachChild(node, visit);
  };
  // 根から辿る
  ts.forEachChild(source, visit);
  // 集めた結果
  return names;
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
 * **ただし別名で取り込んだ呼び出しは「緑側」に倒れうる** — 綴りだけ一致させて中身を別物へ
 * すり替えられるため。`importedFrom` はそれを閉じるので、結線を見張る用途では必ず渡すこと。
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
 *   呼び出しだけを数える (条件で囲む形・関数で 1 ホップ包んでから条件で呼ぶ形を落とす)。
 *   `importedFrom` はその名前が `scripts/lib/<その名前>` から取り込まれ、かつ同名のローカル宣言で
 *   覆われていないことを求める (同名の no-op をその場で宣言して差し替える形を落とす)。
 *   `argument` はその位置の実引数が `callOf` に挙げた関数の**呼び出しそのもの**で、その関数もまた
 *   `importedFrom` 由来であることを求める。`literalArgument` はその位置の実引数が指定した
 *   文字列リテラルそのものであることを求める (どのベンチがどの基準に掛かるかを取り違えさせない)。
 *   `identifierArgument` はその位置の実引数が指定した**素の識別子そのもの**であることを求める
 *   (本物を呼んでから値を丸める関数へ差し替える形を落とす)。`argument.objectArgument` はその判定へ
 *   渡すオブジェクトリテラルが、指定した項目を持ち (`keys`)、指定した項目が指定の文字列リテラルで
 *   あること (`literals`)、指定した呼び出しの結果を展開していること (`spreadOf`) まで求める
 *   (どのベンチの結線かを取り違えさせない／材料の出どころをリテラルへ差し替えさせない)
 * @returns 条件を満たす呼び出しがあれば true
 */
export function callsFunction(
  path: string,
  functionName: string,
  options: {
    atTopLevel?: boolean;
    importedFrom?: string;
    argument?: {
      index: number;
      callOf: readonly string[];
      importedFrom: string;
      objectArgument?: {
        index: number;
        literals: Readonly<Record<string, string>>;
        keys: readonly string[];
        spreadOf?: {
          callOf: string;
          importedFrom: string;
          arrayArgument: { index: number; values: readonly string[] };
        };
        forbiddenKeys?: readonly string[];
      };
    };
    literalArgument?: { index: number; value: string };
    identifierArgument?: { index: number; value: string };
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
    // 文字列リテラルの実引数を求めるなら、その位置を見る
    if (options.literalArgument !== undefined) {
      // 指定した位置の実引数
      const literal = call.args[options.literalArgument.index];
      // 文字列リテラルで、値まで一致すること (変数経由の差し替えを許さない)
      if (literal === undefined || !ts.isStringLiteral(literal)) continue;
      if (literal.text !== options.literalArgument.value) continue;
    }
    // 素の識別子の実引数を求めるなら、その位置を見る
    if (options.identifierArgument !== undefined) {
      // 指定した位置の実引数
      const named = call.args[options.identifierArgument.index];
      // 素の識別子で、名前まで一致すること (包み直した関数への差し替えを許さない)
      if (named === undefined || !ts.isIdentifier(named)) continue;
      if (named.text !== options.identifierArgument.value) continue;
    }
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
    // 判定へ渡すオブジェクトの中身まで見るなら、その位置の実引数を読む
    if (options.argument.objectArgument !== undefined) {
      // 判定の呼び出しの、指定した位置の実引数
      const target = argument.arguments[options.argument.objectArgument.index];
      // オブジェクトリテラルでなければ中身を確かめられない
      if (target === undefined || !ts.isObjectLiteralExpression(target)) continue;
      // 書かれている項目の名前と値
      const written = new Map<string, ts.Expression>();
      // 展開 (`...式`) の式
      const spreads: ts.Expression[] = [];
      // 読めない書き方 (計算キー) があったか
      let unreadableKey = false;
      for (const property of target.properties) {
        // **計算キー (`['status']: 0`) は名前を静的に読めないので、そもそも許さない** (fail-closed)
        if (ts.isPropertyAssignment(property) && ts.isComputedPropertyName(property.name))
          unreadableKey = true;
        // `名前: 値` の形。**文字列リテラルのキーも読む** — 識別子だけを読んでいたときは
        // `'status': 0` と書くだけで直書きの禁止を素通りし、ゲートがベンチの結果を
        // 偽の値で判定する状態が全件緑で作れた (実測)
        if (
          ts.isPropertyAssignment(property) &&
          (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        )
          written.set(property.name.text, property.initializer);
        // 短縮形 (`名前,`)
        else if (ts.isShorthandPropertyAssignment(property))
          written.set(property.name.text, property.name);
        // 展開 (`...式`)。**ここを読まないと材料の出どころが視界の外になる** — 実測で、
        // `...runNpmCapturingStdout([…])` を `status: 0, stdout: '<偽の結果 JSON>'` へ
        // 差し替えるとベンチを 1 本も起動せずにゲートが緑になった (779 件すべて緑)
        else if (ts.isSpreadAssignment(property)) spreads.push(property.expression);
        // **どれにも当てはまらない形 (get/set アクセサ・メソッド定義) は読めないので許さない** —
        // 実測で `get status() { return 0; }` は `written` に入らず、直書きの禁止を素通りした
        // うえ実行時には展開が運んだ本物の値を上書きし、798 件すべて緑のままゲートが緑になった
        else unreadableKey = true;
      }
      // 名前を読めない項目があれば、この呼び出しは求めた形だと確かめられない
      if (unreadableKey) continue;
      // **直書きを禁じた項目が書かれていないこと** (展開で運ぶ材料を手で上書きさせない)
      const forbidden = options.argument.objectArgument.forbiddenKeys ?? [];
      if (forbidden.some((key) => written.has(key))) continue;
      // **展開は先頭の 1 つだけ。** 後ろに置くと、ピン留めした項目を実行時に上書きできてしまう
      // (実測で `limit:` の直後に `...{ valueField: 'limitMs' }` を足すと全件緑のまま恒真式になった)
      if (spreads.length > 1) continue;
      if (spreads.length === 1 && target.properties[0] !== undefined) {
        // 先頭の項目が展開そのものであること
        const first = target.properties[0];
        if (!ts.isSpreadAssignment(first) || first.expression !== spreads[0]) continue;
      }
      // 展開している呼び出しまで求めるなら、その形を見る
      const spreadOf = options.argument.objectArgument.spreadOf;
      if (spreadOf !== undefined) {
        // 条件を満たす展開が 1 つでもあること
        const matched = spreads.some((expression) => {
          // 素の識別子への呼び出しであること
          if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression))
            return false;
          // 名前が一致し、共有モジュール由来であること
          if (expression.expression.text !== spreadOf.callOf) return false;
          if (!comesFromSharedModule(path, source, spreadOf.importedFrom, spreadOf.callOf))
            return false;
          // 指定した位置の実引数が配列リテラルで、中身が文字列リテラルとして一致すること
          const list = expression.arguments[spreadOf.arrayArgument.index];
          if (list === undefined || !ts.isArrayLiteralExpression(list)) return false;
          if (list.elements.length !== spreadOf.arrayArgument.values.length) return false;
          return list.elements.every(
            (element, index) =>
              ts.isStringLiteral(element) && element.text === spreadOf.arrayArgument.values[index],
          );
        });
        // 1 つも無ければこの呼び出しは求めた形ではない
        if (!matched) continue;
      }
      // 求めた項目がすべて書かれていること
      if (!options.argument.objectArgument.keys.every((key) => written.has(key))) continue;
      // 文字列リテラルを求めた項目は、値まで一致すること
      const literals = Object.entries(options.argument.objectArgument.literals);
      if (
        !literals.every(([key, value]) => {
          // その項目の値
          const writtenValue = written.get(key);
          // 文字列リテラルで、中身まで一致すること
          return (
            writtenValue !== undefined &&
            ts.isStringLiteral(writtenValue) &&
            writtenValue.text === value
          );
        })
      )
        continue;
    }
    // すべて満たした
    return true;
  }
  // 条件を満たす呼び出しは無い
  return false;
}
