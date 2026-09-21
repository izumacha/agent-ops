// エラーをログへ落とす形の不変条件。
// `src/lib/describe-error.ts` の `describeError` が**唯一の経路**で、ここを通さずに
// 例外オブジェクトや `error.message` を出すと、ORM の検証エラー（message にクエリ引数＝
// メールアドレス・名前が埋め込まれる）や pg のプールエラー（接続情報）がそのままログへ流れる。
// 実測で、`proxy-route.ts` の記録失敗ログを `error.name` から `error` に変える変異は
// 864 件すべて緑・件数も不変のまま通った（§9 ログに機密・PII を漏らさない）
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { forEachNode, parseSourceFiles } from './lib/source-files';

// 形を決める唯一の関数の名前
const DESCRIBE_ERROR = 'describeError';

// 走査結果はモジュール評価時に 1 度だけ作る
const SOURCES = parseSourceFiles();

// `console.error(...)` の呼び出しか
function isConsoleError(node: ts.Node): node is ts.CallExpression {
  // 呼び出しでなければ違う
  if (!ts.isCallExpression(node)) return false;
  // `console.error` の形（レシーバの綴りは問わない: `globalThis.console.error` も拾う）
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'error' &&
    callee.expression.getText().endsWith('console')
  );
}

// その式が `error` という名前の束縛に触れているか（`error` / `error.message` / 三項など）
function mentionsErrorBinding(node: ts.Node): boolean {
  // 見つけた印
  let found = false;
  // 部分式をすべて見る
  forEachNode(node, (child) => {
    // 識別子 `error` そのもの（プロパティ名としての `error` は除く）
    if (ts.isIdentifier(child) && child.text === 'error') {
      // `x.error` の `error` はプロパティ名なので数えない
      const parent = child.parent as ts.Node | undefined;
      const isPropertyName =
        parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.name === child;
      if (!isPropertyName) found = true;
    }
  });
  return found;
}

describe('エラーのログ出力', () => {
  it('console.error の実引数で例外に触れるものは describeError を通している', () => {
    // 1 ファイルも読めなければ走査が壊れている (fail-closed)
    expect(SOURCES.length, 'src 配下の TypeScript を 1 つも読めない').toBeGreaterThan(0);
    // 規約を破っている箇所
    const offenders: string[] = [];
    // 実際に見た console.error の件数（0 なら判定が空振りしている）
    let inspected = 0;
    for (const { path, source } of SOURCES)
      forEachNode(source, (node) => {
        // console.error の呼び出しだけを見る
        if (!isConsoleError(node)) return;
        inspected += 1;
        for (const argument of node.arguments) {
          // 例外に触れていない実引数（定型のメッセージなど）は対象外
          if (!mentionsErrorBinding(argument)) continue;
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
    // console.error を 1 件も見ていなければ走査が壊れている (fail-closed)
    expect(inspected, 'console.error の呼び出しを 1 つも見つけられない').toBeGreaterThan(0);
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
