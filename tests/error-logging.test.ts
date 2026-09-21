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
// **残る境界**（いずれも実測で素通りを確認）: `console` 以外の出力
// （`process.stderr.write`・ログライブラリ）、レシーバを変数へ入れる形（`const c = console`）、
// `console` からの分割代入（`const { error: logError } = console`）、計算した添字
// （`console[m]`）。これらは署名から追えないので規約とレビューで守る。
// **括弧・`.call` / `.apply` / `.bind` は剥がして見る** — これらは Prettier も ESLint も
// 書き換えないので「意図的に迂回した形」には見えず、レビューを通りやすいため。
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { basename, dirname, join, resolve } from 'node:path';
import { forEachNode, parseSourceFiles } from './lib/source-files';

// 形を決める唯一の関数の名前
const DESCRIBE_ERROR = 'describeError';

// ログを吐く console のメソッド。**`error` だけを見ない** — 実測で `console.warn('…', error)` は
// 素通りした。出力先が stderr か stdout かは問題ではなく、message が残ることが問題
const CONSOLE_METHODS = new Set(['error', 'warn', 'log', 'info', 'debug', 'trace']);

// テンプレートの置換に置いてよい識別子と、その理由。
// **例外にも利用者の入力にも由来しない値だけ**を登録する。エントリが増える差分は
// 理由の妥当性をレビューで確認する（この repo の他の除外表と同じ扱い）。
// **ただしレビュー任せの範囲は構文で狭める** — 登録名は「モジュールスコープの `const` で
// リテラル初期化子を持つ」ことまで要求する。そうしないと `error` / `err` / `message` の
// ような**まさに塞ぎたい名前ほど**「src に実在する」という条件を自明に満たしてしまい、
// 1 行足すだけで例外の message をテンプレートへ埋められた（実測で 3 件緑）
const SAFE_SUBSTITUTIONS: Record<string, string> = {
  PLATFORM_ADMIN_TOKEN_MIN_LENGTH:
    '設定の下限値を表す定数。例外にも利用者の入力にも由来せず、値は公開しても差し支えない',
};

// 走査結果はモジュール評価時に 1 度だけ作る
const SOURCES = parseSourceFiles();

/**
 * モジュール指定子を実ファイルの絶対パスへ解決する。
 * **綴りで照合しない** — 取り込み元を名前の末尾一致で見ていた版は、同じ名前のファイルを
 * 別ディレクトリに置くだけで所有モジュールごと差し替えられた（実測）。
 * @param from 取り込む側のファイルの絶対パス
 * @param specifier `import … from '<ここ>'` の綴り
 * @returns 解決した絶対パス（`.ts` 付き）
 */
function resolveModule(from: string, specifier: string): string {
  // `@/` はパスエイリアス（tsconfig の `@/*` → `src/*`）
  const base = specifier.startsWith('@/')
    ? join(process.cwd(), 'src', specifier.slice('@/'.length))
    : resolve(dirname(from), specifier);
  // 拡張子が無ければ `.ts` を補う
  return /\.[cm]?tsx?$/.test(base) ? base : `${base}.ts`;
}

// 括弧と `.call` / `.apply` / `.bind` を剥がして、元の呼び先まで辿る
function unwrapCallee(expression: ts.Expression): ts.Expression {
  // 括弧を剥がす（`(0, console.error)` のカンマ式は右端が呼び先）
  let current: ts.Expression = expression;
  for (;;) {
    // `( … )`
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    // `a, b` のカンマ式は右端
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      current = current.right;
      continue;
    }
    // `f.call` / `f.apply` / `f.bind` は f まで戻る
    if (
      ts.isPropertyAccessExpression(current) &&
      ['call', 'apply', 'bind'].includes(current.name.text)
    ) {
      current = current.expression;
      continue;
    }
    // `f.bind(console)(…)` のように、剥がした先がさらに呼び出しなら中を見る
    if (ts.isCallExpression(current)) {
      // 呼び先が `f.bind` の形のときだけ辿る（無関係な呼び出しを巻き込まない）
      const inner = current.expression;
      if (ts.isPropertyAccessExpression(inner) && inner.name.text === 'bind') {
        current = inner.expression;
        continue;
      }
    }
    return current;
  }
}

// console のログ呼び出しか
function isConsoleLog(node: ts.Node): node is ts.CallExpression {
  // 呼び出しでなければ違う
  if (!ts.isCallExpression(node)) return false;
  // 呼び出す先。**括弧と `.call` / `.apply` / `.bind` を剥がしてから見る** — 実測で
  // `console.error.call(console, …)` / `.apply` / `.bind(console)(…)` /
  // `(0, console.error)(…)` / `(console.error)(…)` の 5 形がどれも素通りした。
  // `.call` / `.apply` は Prettier も ESLint も書き換えないので、`console[m]` と違って
  // 「意図的に迂回した形」には見えない = レビューを通りやすい
  const callee = unwrapCallee(node.expression);
  // レシーバが console であること。**綴りの末尾一致で見ない** — 実測で
  // `globalThis['console'].error('…', error)` が素通りした（メソッド側の
  // `console['error']` はわざわざ拾っているのに、レシーバ側の同じ形が抜けていた）
  const isConsoleReceiver = (receiver: ts.Expression): boolean => {
    // `console` そのもの
    if (ts.isIdentifier(receiver)) return receiver.text === 'console';
    // `globalThis.console` のような形
    if (ts.isPropertyAccessExpression(receiver)) return receiver.name.text === 'console';
    // `globalThis['console']` のような形
    if (ts.isElementAccessExpression(receiver))
      return (
        ts.isStringLiteralLike(receiver.argumentExpression) &&
        receiver.argumentExpression.text === 'console'
      );
    return false;
  };
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
      (span) =>
        ts.isIdentifier(span.expression) &&
        // **`in` で見ない** — オブジェクトリテラルは `Object.prototype` を継承するので、
        // `toString` / `constructor` / `valueOf` は**登録せずに許可されていた**（実測で
        // `const toString = error instanceof Error ? error.message : String(error);` が
        // 3 件緑を通った）。許可表を 1 文字も触らないので差分にも現れない
        Object.hasOwn(SAFE_SUBSTITUTIONS, span.expression.text),
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

  it('許可表に登録できるのはリテラルで初期化したモジュール定数だけ', () => {
    // 「モジュールスコープの `const` で、数値か文字列のリテラルで初期化されている」名前
    const literalConstants = new Set<string>();
    for (const { source } of SOURCES)
      // **文のトップレベルだけを見る**（関数の中の const は含めない）
      for (const statement of source.statements) {
        // `const x = …;` の形か
        if (!ts.isVariableStatement(statement)) continue;
        if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
        for (const declaration of statement.declarationList.declarations) {
          // 名前と初期化子
          const initializer = declaration.initializer;
          if (!ts.isIdentifier(declaration.name) || initializer === undefined) continue;
          // リテラル（数値・文字列・置換の無いテンプレート）で初期化されていること
          if (
            ts.isNumericLiteral(initializer) ||
            ts.isStringLiteralLike(initializer) ||
            (ts.isAsExpression(initializer) &&
              (ts.isNumericLiteral(initializer.expression) ||
                ts.isStringLiteralLike(initializer.expression)))
          )
            literalConstants.add(declaration.name.text);
        }
      }
    // 手掛かりが 0 件なら走査が壊れている (fail-closed)
    expect(literalConstants.size, 'リテラルのモジュール定数を 1 つも読めない').toBeGreaterThan(0);
    // 登録が条件を満たすこと
    for (const [name, reason] of Object.entries(SAFE_SUBSTITUTIONS)) {
      // **「src に識別子として現れる」だけでは足りない** — `error` / `err` / `message` の
      // ような、まさに塞ぎたい名前ほどその条件を自明に満たす（実測で `error` を
      // 登録するだけで例外の message をテンプレートへ埋められた）
      expect(
        literalConstants.has(name),
        `${name} はリテラルで初期化したモジュール定数ではない (例外・引数・catch 束縛は登録できない)`,
      ).toBe(true);
      expect(reason.trim().length, `${name} の許可に理由が無い`).toBeGreaterThan(0);
    }
  });

  it('describeError という名前の出自は所有モジュールだけ', () => {
    // 所有モジュールの絶対パス
    const owner = join(process.cwd(), 'src', 'lib', 'describe-error.ts');
    // 所有モジュールが実在すること (fail-closed)
    expect(
      SOURCES.some(({ path }) => path === owner),
      `${DESCRIBE_ERROR} の所有モジュールが無い`,
    ).toBe(true);
    // **同じ名前のファイルが 2 つ以上あれば落とす** — 取り込み元の判定を 1 つ漏らしても、
    // この独立な手がかりが囮モジュールの存在自体を捉える (fail-closed)
    const sameNamed = SOURCES.filter(({ path }) => basename(path) === basename(owner));
    expect(
      sameNamed.map(({ path }) => path.slice(process.cwd().length + 1)),
      '所有モジュールと同じ名前のファイルが複数ある',
    ).toEqual([owner.slice(process.cwd().length + 1)]);
    // 規約を破っている箇所
    const offenders: string[] = [];
    for (const { path, source } of SOURCES) {
      // 所有モジュール自身は宣言してよい
      const isOwner = path === owner;
      // このファイルが所有モジュールから名前を変えずに named import しているか
      let imported = false;
      // このファイルがその名前を import 以外で束縛しているか
      let shadowed = false;
      // 呼んでいるか
      let calls = false;
      forEachNode(source, (node) => {
        // `import { describeError } from '@/lib/describe-error'` の形
        if (
          ts.isImportSpecifier(node) &&
          node.name.text === DESCRIBE_ERROR &&
          // `as` で名前を付け替えていないこと（別物を describeError と名乗らせない）
          node.propertyName === undefined
        ) {
          // 取り込み元。**綴りの末尾一致で見ない** — 実測で、`describe-error` という名前の
          // ファイルを別ディレクトリに置いて `export { x as describeError } from './x'` の
          // 1 行にするだけで、tsc・eslint・このガード 3/3 が緑のまま所有モジュールごと
          // 差し替えられ、メールアドレスと接続文字列を含む生の Error が console.error へ届いた
          const from = node.parent.parent.parent.moduleSpecifier;
          if (ts.isStringLiteralLike(from) && resolveModule(path, from.text) === owner)
            imported = true;
        }
        // **再公開も禁止** — `export { x as describeError } from './x'` は束縛の検出にも
        // 取り込み元の検出にも引っかからないまま、所有モジュールの名前を名乗れる
        if (!isOwner && ts.isExportSpecifier(node) && node.name.text === DESCRIBE_ERROR)
          shadowed = true;
        // **import 以外の束縛**（`const` / `function` / 仮引数）は所有モジュール以外では禁止
        if (
          !isOwner &&
          (ts.isVariableDeclaration(node) ||
            ts.isFunctionDeclaration(node) ||
            ts.isParameter(node)) &&
          node.name !== undefined &&
          ts.isIdentifier(node.name) &&
          node.name.text === DESCRIBE_ERROR
        )
          shadowed = true;
        // **分割代入で覆う形も禁止** — `const { describeError } = deps;` や
        // `function f(e, { describeError }: Deps = DEFAULT)` は「テストのために診断の
        // 作り方を注入できるようにする」というごく普通の DI の形に見えるのに、
        // 実測で imported=true / shadowed=false のまま覆えた
        if (
          !isOwner &&
          ts.isBindingElement(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === DESCRIBE_ERROR
        )
          shadowed = true;
        // 呼び出し
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === DESCRIBE_ERROR
        )
          calls = true;
      });
      // 同名の別物で覆っていないこと
      if (shadowed)
        offenders.push(`${path.slice(process.cwd().length + 1)}: 同名の別の束縛で覆っている`);
      // 呼ぶなら所有モジュールから取り込んでいること
      if (calls && !isOwner && !imported)
        offenders.push(
          `${path.slice(process.cwd().length + 1)}: 所有モジュールから取り込まずに呼んでいる`,
        );
    }
    // **許可リストは `describeError` という「名前」を信頼している**ので、その名前の出自を
    // 縛るのが要。実測で、`src/lib/stream-bytes.ts` の import 1 行を同名の `const`
    // パススルーへ差し替えるだけで、tsc・eslint・851 件すべてが件数まで含めて
    // ベースラインと完全一致のまま緑になり、生の例外が console.error へ流れた
    expect(offenders, `${DESCRIBE_ERROR} は所有モジュールのものだけを使う`).toEqual([]);
  });
});
