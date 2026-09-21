// エラーをログへ落とす形の不変条件。
// `src/lib/describe-error.ts` の `describeError` が**唯一の経路**で、ここを通さずに
// 例外オブジェクトや `error.message` を出すと、ORM の検証エラー（message にクエリ引数＝
// メールアドレス・名前が埋め込まれる）や pg のプールエラー（接続情報）がそのままログへ流れる。
//
// **「例外を指す束縛を同定する」のをやめ、実引数の許可リストにしている（高度の話）。**
// 束縛を同定する形は、綴りを 1 つ塞ぐたびに次の形が出た（いずれも実測で全件緑）:
//   `error` の決め打ち → `catch (err)` / `(poolError: Error) => …`
//   → `.catch((error: unknown) => …)`（そのファイルは 1 引数も検査されなかった）
//   → **`: Error` の注釈を外すだけ**（型は文脈から決まるので注釈は省略でき、`tsc` も緑）。
// 最後の形が決定的で、**網が成立する条件が「書き手が自由に省略できる構文」**になっていた
// （冗長な注釈を消すのはレビューが通しやすい向きの編集なので、向きが逆の設計）。
//
// そこで問いを裏返す: 「その実引数は例外か？」ではなく**「ログに出してよい形か？」**。
// 出してよいのは (1) 文字列リテラル (2) 置換の無いテンプレート (3) `describeError(...)`
// (4) 許可表に登録した安全な識別子だけを置換に持つテンプレート の 4 つで、それ以外は落とす。
// これで束縛の同定という問題そのものが消え、注釈・`unknown`・union・分割代入・
// 文脈型付けがすべて同じ 1 本の規則で閉じる（fail-closed）。
//
// **残る境界**: `console` 以外の出力（`process.stderr.write`・ログライブラリ）、
// レシーバを変数へ入れる形（`const c = console`）、計算した添字（`console[m]`）は
// 署名から追えないので規約とレビューで守る。
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { forEachNode, parseSourceFiles } from './lib/source-files';

// 形を決める唯一の関数の名前
const DESCRIBE_ERROR = 'describeError';

// ログを吐く console のメソッド。**`error` だけを見ない** — 実測で `console.warn('…', error)` は
// 素通りした。出力先が stderr か stdout かは問題ではなく、message が残ることが問題
const CONSOLE_METHODS = new Set(['error', 'warn', 'log', 'info', 'debug', 'trace']);

// テンプレートの置換に置いてよい識別子と、その理由。
// **例外にも利用者の入力にも由来しない値だけ**を登録する。エントリが増える差分は
// 理由の妥当性をレビューで確認する（この repo の他の除外表と同じ扱い）
const SAFE_SUBSTITUTIONS: Record<string, string> = {
  PLATFORM_ADMIN_TOKEN_MIN_LENGTH:
    '設定の下限値を表す定数。例外にも利用者の入力にも由来せず、値は公開しても差し支えない',
};

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
  // **`console['error']` の形も拾う** — 実測で、要素アクセスにするだけで素通りした
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

// その実引数はログに出してよい形か
function isAllowedLogArgument(argument: ts.Expression): boolean {
  // (1) 文字列リテラル
  if (ts.isStringLiteralLike(argument)) return true;
  // (3) `describeError(...)` の呼び出し
  if (
    ts.isCallExpression(argument) &&
    ts.isIdentifier(argument.expression) &&
    argument.expression.text === DESCRIBE_ERROR
  )
    return true;
  // (2)(4) テンプレート: 置換がすべて許可表の識別子であること（置換なしもここで通る）
  if (ts.isTemplateExpression(argument))
    return argument.templateSpans.every(
      (span) => ts.isIdentifier(span.expression) && span.expression.text in SAFE_SUBSTITUTIONS,
    );
  // それ以外は通さない (fail-closed)
  return false;
}

describe('エラーのログ出力', () => {
  it('console のログの実引数は「出してよい形」だけ', () => {
    // 1 ファイルも読めなければ走査が壊れている (fail-closed)
    expect(SOURCES.length, 'src 配下の TypeScript を 1 つも読めない').toBeGreaterThan(0);
    // 規約を破っている箇所
    const offenders: string[] = [];
    // 実際に見た console のログ呼び出しの件数（0 なら判定が空振りしている）
    let inspected = 0;
    for (const { path, source } of SOURCES)
      forEachNode(source, (node) => {
        // console のログ呼び出しだけを見る
        if (!isConsoleLog(node)) return;
        inspected += 1;
        for (const argument of node.arguments) {
          // 出してよい形なら次へ
          if (isAllowedLogArgument(argument)) continue;
          // それ以外はそのまま失敗文言に出す
          offenders.push(
            `${path.slice(process.cwd().length + 1)}: ${argument.getText().replace(/\s+/g, ' ')}`,
          );
        }
      });
    // 1 件も見ていなければ走査が壊れている (fail-closed)
    expect(inspected, 'console のログ呼び出しを 1 つも見つけられない').toBeGreaterThan(0);
    // 破っている箇所があれば、直し方まで文言に書く
    expect(
      offenders,
      `ログに出してよいのは 文字列リテラル / 置換の無いテンプレート / ${DESCRIBE_ERROR}(...) / ` +
        '許可表の識別子だけを置換に持つテンプレート だけ (例外の message には PII や接続情報が載る)',
    ).toEqual([]);
  });

  it('許可表の識別子は実在し、理由が空でない', () => {
    // src 全体に現れる識別子の名前
    const declared = new Set<string>();
    for (const { source } of SOURCES)
      forEachNode(source, (node) => {
        if (ts.isIdentifier(node)) declared.add(node.text);
      });
    // 登録が古くなっていないこと
    for (const [name, reason] of Object.entries(SAFE_SUBSTITUTIONS)) {
      expect(declared.has(name), `${name} は src に存在しない (許可表が古い)`).toBe(true);
      expect(reason.trim().length, `${name} の許可に理由が無い`).toBeGreaterThan(0);
    }
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
