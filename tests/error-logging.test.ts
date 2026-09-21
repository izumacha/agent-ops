// エラーをログへ落とす形の不変条件。
// `src/lib/describe-error.ts` の `describeError` が**唯一の経路**で、ここを通さずに
// 例外オブジェクトや `error.message` を出すと、ORM の検証エラー（message にクエリ引数＝
// メールアドレス・名前が埋め込まれる）や pg のプールエラー（接続情報）がそのままログへ流れる。
// 実測で、`proxy-route.ts` の記録失敗ログを `error.name` から `error` に変える変異は
// 864 件すべて緑・件数も不変のまま通った（§9 ログに機密・PII を漏らさない）。
//
// **これは証明ではなく「増えたことに気付く網」。残る境界（すべて実測で素通りを確認）**:
//   - 1 段の間接化: `const detail = error; console.error('…', detail)`
//     （値は任意の式の文脈から外へ出られるので、署名からは追えない）
//   - 分割代入で先に取り出す形: `const { message } = error; console.error('…', message)`
//   - `console` 以外の出力: `process.stderr.write(...)`、ログライブラリ
//   - レシーバを変数へ入れる形: `const c = console; c.error('…', error)`
//   - 計算した添字: `const m = 'error'; console[m]('…', error)`
// これらは規約とレビューで守る。**網の射程を「唯一の経路であることの証明」と読み替えない。**
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { forEachNode, parseSourceFiles } from './lib/source-files';

// 形を決める唯一の関数の名前
const DESCRIBE_ERROR = 'describeError';

// ログを吐く console のメソッド。**`error` だけを見ない** — 実測で `console.warn('…', error)` は
// 素通りした。出力先が stderr か stdout かは問題ではなく、message が残ることが問題
const CONSOLE_METHODS = new Set(['error', 'warn', 'log', 'info', 'debug', 'trace']);

// 走査結果はモジュール評価時に 1 度だけ作る
const SOURCES = parseSourceFiles();

// console のログ呼び出しか
function isConsoleLog(node: ts.Node): node is ts.CallExpression {
  // 呼び出しでなければ違う
  if (!ts.isCallExpression(node)) return false;
  // 呼び出す先
  const callee = node.expression;
  // レシーバが console であること（綴りは問わない: `globalThis.console.error` も拾う）
  const isConsoleReceiver = (receiver: ts.Expression): boolean =>
    receiver.getText().endsWith('console');
  // `console.<メソッド>` の形
  if (ts.isPropertyAccessExpression(callee))
    return CONSOLE_METHODS.has(callee.name.text) && isConsoleReceiver(callee.expression);
  // **`console['error']` の形も拾う** — 実測で、要素アクセスにするだけで素通りした。
  // 「レシーバの綴りは問わない」という設計の意図からして、ここは取りこぼしであって境界ではない
  if (ts.isElementAccessExpression(callee)) {
    // 添字が文字列リテラルのときだけ読める（`console[m]` は原理的に追えない）
    const index = callee.argumentExpression;
    return (
      ts.isStringLiteralLike(index) &&
      CONSOLE_METHODS.has(index.text) &&
      isConsoleReceiver(callee.expression)
    );
  }
  return false;
}

/**
 * そのファイルで「例外を受け取っている束縛」の名前を**構文から**集める。
 *
 * **綴り `error` を決め打ちしない** — 実測で `catch (e)` / `catch (err)` や
 * `(poolError: Error) => …` はどれも素通りし、後者は「`error.message` を素で出す経路を
 * 閉じた」と述べたまさにその 2 行を 1 語のリネームで検出網の外へ出せた。
 * 集めるのは (a) `catch` 節が束縛した名前、(b) 型注釈が `Error` の仮引数。
 * @param source 1 ファイル分の構文木
 * @returns 例外を指す識別子の名前
 */
function errorBindingNames(source: ts.SourceFile): Set<string> {
  // 集めた名前
  const names = new Set<string>();
  // 構文木をすべて辿る
  forEachNode(source, (node) => {
    // (a) `catch (x)` の x
    if (ts.isCatchClause(node)) {
      // 束縛名（`catch {}` のように省略できるので undefined を許す）
      const bound = node.variableDeclaration?.name;
      if (bound !== undefined && ts.isIdentifier(bound)) names.add(bound.text);
    }
    // (b) `(x: Error) => …` の x（型注釈が Error / *Error で終わる仮引数）
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      // 型注釈の綴り
      const annotation = node.type?.getText() ?? '';
      if (/(^|\W)\w*Error$/.test(annotation)) names.add(node.name.text);
    }
    // (c) `p.catch((x) => …)` の x。**型注釈に頼らない** — 実測で、`src/lib/stream-bytes.ts` は
    // `.catch((error: unknown) => …)` しか持たないため (a)(b) だけでは束縛が 1 つも集まらず、
    // そのファイルの console.error は 1 引数も検査されていなかった（生の `error` を足す変異が
    // 850 件すべて緑を通った）。`unknown` は TS で最も普通の catch 引数の綴りなので、
    // 注釈ではなく**「catch へ渡したコールバックの第 1 仮引数」という位置**で拾う
    if (ts.isCallExpression(node)) {
      // `x.catch(...)` の形か
      const callee = node.expression;
      const isCatchCall =
        ts.isPropertyAccessExpression(callee) && callee.name.text === 'catch'
          ? true
          : ts.isElementAccessExpression(callee) &&
            ts.isStringLiteralLike(callee.argumentExpression) &&
            callee.argumentExpression.text === 'catch';
      // 第 1 引数が関数なら、その第 1 仮引数が例外を受け取る
      const handler = node.arguments[0];
      if (
        isCatchCall &&
        handler !== undefined &&
        (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))
      ) {
        // 受け取る仮引数
        const bound = handler.parameters[0]?.name;
        if (bound !== undefined && ts.isIdentifier(bound)) names.add(bound.text);
      }
    }
  });
  return names;
}

// その式が、例外を指す束縛のどれかに触れているか（`e` / `err.message` / 三項など）
function mentionsErrorBinding(node: ts.Node, bindings: Set<string>): boolean {
  // 見つけた印
  let found = false;
  // 部分式をすべて見る
  forEachNode(node, (child) => {
    // 例外を指す識別子そのもの
    if (ts.isIdentifier(child) && bindings.has(child.text)) {
      // `x.err` の `err` はプロパティ名なので数えない
      const parent = child.parent as ts.Node | undefined;
      const isPropertyName =
        parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.name === child;
      if (!isPropertyName) found = true;
    }
  });
  return found;
}

describe('エラーのログ出力', () => {
  it('console のログの実引数で例外に触れるものは describeError を通している', () => {
    // 1 ファイルも読めなければ走査が壊れている (fail-closed)
    expect(SOURCES.length, 'src 配下の TypeScript を 1 つも読めない').toBeGreaterThan(0);
    // 規約を破っている箇所
    const offenders: string[] = [];
    // 実際に見た console のログ呼び出しの件数（0 なら判定が空振りしている）
    let inspected = 0;
    for (const { path, source } of SOURCES) {
      // このファイルで例外を受け取っている束縛の名前（綴りを決め打ちしない）
      const bindings = errorBindingNames(source);
      forEachNode(source, (node) => {
        // console のログ呼び出しだけを見る
        if (!isConsoleLog(node)) return;
        inspected += 1;
        for (const argument of node.arguments) {
          // 例外に触れていない実引数（定型のメッセージなど）は対象外
          if (!mentionsErrorBinding(argument, bindings)) continue;
          // 触れているなら、その実引数まるごとが describeError(...) であること
          const wrapped =
            ts.isCallExpression(argument) &&
            ts.isIdentifier(argument.expression) &&
            argument.expression.text === DESCRIBE_ERROR;
          if (!wrapped)
            offenders.push(
              `${path.slice(process.cwd().length + 1)}: ${argument.getText().replace(/\s+/g, ' ')}`,
            );
        }
      });
    }
    // 1 件も見ていなければ走査が壊れている (fail-closed)
    expect(inspected, 'console のログ呼び出しを 1 つも見つけられない').toBeGreaterThan(0);
    // 破っている箇所があれば、そのまま失敗文言に出す
    expect(
      offenders,
      `例外を ${DESCRIBE_ERROR}() を通さずにログへ出している (message に PII や接続情報が載る)`,
    ).toEqual([]);
  });

  it('describeError の定義は 1 か所だけ', () => {
    // その名前で関数を宣言しているファイル
    const definitions: string[] = [];
    for (const { path, source } of SOURCES)
      forEachNode(source, (node) => {
        // `export function describeError(...)` の形
        if (ts.isFunctionDeclaration(node) && node.name?.text === DESCRIBE_ERROR)
          definitions.push(path);
      });
    // **写しを持たせない** — 経路ごとに別の実装ができると、片方だけが message を素で出す
    expect(definitions.length, `${DESCRIBE_ERROR} の定義が 1 か所ではない`).toBe(1);
  });
});
