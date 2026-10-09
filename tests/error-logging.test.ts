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
// **呼び先を分岐・転送する形も剥がして見る**: 括弧・カンマ式・`.call` / `.apply` / `.bind` /
// `Reflect.apply(console.error, …)` / `cond ? console.error : console.warn` /
// `console.error ?? console.warn`。これらは Prettier も ESLint も書き換えないので
// 「意図的に迂回した形」には見えず、レビューを通りやすい（実測で全形が素通りした）。
// **包みごとにログへ出る実引数の位置が違う**ので、剥がした種類に応じて取り出す
// （`.call(this, …)` の先頭は this なのでログには出ない。一律に判定へ回していた版は
// `console` という識別子を毎回「許していない形」として報告し、失敗文言が嘘になっていた）。
//
// **残る境界**（いずれも実測で素通りを確認）: `console` 以外の出力
// （`process.stderr.write`・ログライブラリ）、レシーバを変数へ入れる形（`const c = console`）、
// `console` からの分割代入（`const { error: logError } = console`）、計算した添字
// （`console[m]`）。これらは署名から追えないので規約とレビューで守る。
// **走査範囲は `src/` だけ**（`parseSourceFiles`）。`scripts/` の開発用 CLI は運用者が
// 手元で動かすもので、`scripts/issue-user-token.ts` は発行したトークンを**意図的に**
// 標準出力へ書く（それがこの CLI の成果物）。同じ規則を掛けると理由付きの除外を
// 足すことになり、除外表はこのリポジトリが繰り返し「静かに緩む口」として見てきた形なので、
// 範囲を広げずに境界として記録する。
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { basename, dirname, join, resolve } from 'node:path';
import {
  callArgumentsFor,
  forEachNode,
  namedCallArguments,
  parseSourceFiles,
} from './lib/source-files';
import { LOG_EVENTS } from '@/lib/log';

// 形を決める唯一の関数の名前
const DESCRIBE_ERROR = 'describeError';

// ログの出口を所有するモジュール（**`console` を呼べるのは src 全体でここだけ**）
const LOG_OWNER = join(process.cwd(), 'src', 'lib', 'log.ts');
// 出口の関数の名前（呼び出し側が使う）
const LOG_EVENT = 'logEvent';

/**
 * ログの出口の関数と、受け取れる実引数の最大数。
 *
 * **出口は 1 つではない。** `logEvent`（毎回 1 行）・`logEventThrottled`（窓の中の通算件数が
 * 2 の冪の回だけ。未認証で誰でも叩ける経路の「断った」記録用）・`logEventOnce`（1 プロセスに
 * 1 度だけ。設定の通知用）で、**どれも第 1 引数は語彙のキーのリテラル**。名前を 1 つだけ
 * 決め打っていた頃は、間引く側へ変数や例外の `message` を渡しても**どの検査にも
 * 掛からなかった**（この表から導くので、出口を増やす人はここへ 1 行足すことになり、
 * 足し忘れは下の「語彙を全部出している」側が先に落とす）。
 */
const LOG_OUTLETS: Readonly<Record<string, number>> = {
  // 出来事 ＋ 診断（`describeError(...)`）
  [LOG_EVENT]: 2,
  // 間引く側は出来事だけ（診断を渡せる形にすると、間引かれた回の診断が黙って消える）
  logEventThrottled: 1,
  // 1 度だけの側も出来事だけ（同じ理由。2 度目以降の診断が黙って消える）
  logEventOnce: 1,
};
// 1 行を組み立てる関数の名前（`console` へ渡してよい形の 1 つ）
const FORMAT_LOG_LINE = 'formatLogLine';

// ログを吐く console のメソッド。**`error` だけを見ない** — 実測で `console.warn('…', error)` は
// 素通りした。出力先が stderr か stdout かは問題ではなく、message が残ることが問題
const CONSOLE_METHODS = new Set(['error', 'warn', 'log', 'info', 'debug', 'trace']);

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

// 呼び先が console のログメソッドを指しているか（分岐は「どれか 1 つでも」で見る = fail-closed）
function isConsoleCallee(expression: ts.Expression): boolean {
  // 括弧を剥がす
  if (ts.isParenthesizedExpression(expression)) return isConsoleCallee(expression.expression);
  // **`cond ? console.error : console.warn` / `console.error ?? console.warn`** のように
  // 呼び先そのものを分岐させる形。どちらかが console なら検査の対象にする
  if (ts.isConditionalExpression(expression))
    return isConsoleCallee(expression.whenTrue) || isConsoleCallee(expression.whenFalse);
  if (
    ts.isBinaryExpression(expression) &&
    [
      ts.SyntaxKind.QuestionQuestionToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.AmpersandAmpersandToken,
    ].includes(expression.operatorToken.kind)
  )
    return isConsoleCallee(expression.left) || isConsoleCallee(expression.right);
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
  if (ts.isPropertyAccessExpression(expression))
    return CONSOLE_METHODS.has(expression.name.text) && isConsoleReceiver(expression.expression);
  // **`console['error']` の形も拾う** — 実測で、要素アクセスにするだけで素通りした
  if (ts.isElementAccessExpression(expression)) {
    // 添字が文字列リテラルのときだけ読める（`console[m]` は原理的に追えない）
    const index = expression.argumentExpression;
    return (
      ts.isStringLiteralLike(index) &&
      CONSOLE_METHODS.has(index.text) &&
      isConsoleReceiver(expression.expression)
    );
  }
  return false;
}

/**
 * console のログ呼び出しなら、実際にログへ出る実引数を返す（違えば null）。
 * @param node 走査中のノード
 * @returns 実引数（console の呼び出しでなければ null）
 */
function consoleLogArguments(node: ts.Node): readonly ts.Expression[] | null {
  // 呼び先の判定だけを差し替えて同じ剥がし方を使う
  return callArgumentsFor(node, isConsoleCallee);
}

// その実引数はログに出してよい形か
function isAllowedLogArgument(argument: ts.Expression): boolean {
  // (1) 文字列リテラル・置換の無いテンプレート（`isStringLiteralLike` が両方を通す）
  if (ts.isStringLiteralLike(argument)) return true;
  // (3) `describeError(...)` の呼び出し
  if (
    ts.isCallExpression(argument) &&
    ts.isIdentifier(argument.expression) &&
    argument.expression.text === DESCRIBE_ERROR
  )
    return true;
  // (5) `formatLogLine(...)` の呼び出し。許せる理由は (3) と同じで、**受け取れる値が構造で
  // 縛られている**から（第 1 引数は閉じた語彙のキー、第 2 引数は describeError が作った診断）。
  // この形が現れるのは所有モジュール（src/lib/log.ts）の中だけで、それは下の
  // 「console を呼べるのは出口のモジュールだけ」が別に固定する
  if (
    ts.isCallExpression(argument) &&
    ts.isIdentifier(argument.expression) &&
    argument.expression.text === FORMAT_LOG_LINE
  )
    return true;
  // それ以外は通さない (fail-closed)。
  // **置換を持つテンプレートは一律に通さない。** 以前は「許可表に登録した識別子だけを
  // 置換に持つテンプレート」を許していたが、`console` を呼ぶのが出口の 1 行だけになった時点で
  // その枝は**どの呼び出しからも到達しなくなり**、残ったのは「登録するだけで黙らせられる口」
  // としての除外表だけだった（この repo が繰り返し避けている形）。設定値を文言へ入れたいときは
  // 値ではなく**定数の名前**を書く（notify と log.ts の既存の文言がその形）。
  return false;
}

/**
 * 出口の所有モジュール（`src/lib/log.ts`）が持つ、**語彙のキーと同じ綴りの文字列リテラル**。
 *
 * あのファイルは自分の縮退の行を自分の出口に通さない（通すと同じ理由で投げうる）ので、
 * 出口の呼び出しからは見えない。**語彙に実在する綴りだけを拾う**ので、無関係なリテラルを
 * 「出している」ことにはしない。
 * @returns 見つけた綴り
 */
function ownerEventLiterals(): Set<string> {
  // 語彙のキー（この集合に無い綴りは拾わない）
  const vocabulary = new Set<string>(Object.keys(LOG_EVENTS));
  // 見つけた綴り
  const found = new Set<string>();
  // 所有モジュールだけを見る
  for (const { path, source } of SOURCES) {
    if (path !== LOG_OWNER) continue;
    forEachNode(source, (node) => {
      // 文字列リテラルで、語彙に実在する綴りのものだけ
      if (!ts.isStringLiteralLike(node)) return;
      if (!vocabulary.has(node.text)) return;
      // **語彙そのものの鍵は数えない。** `LOG_EVENTS` はこのファイルにあるので、鍵の
      // リテラルまで拾うと**宣言しただけで「出している」ことになり、この検査が丸ごと死ぬ**
      // （実測で、縮退の行を語彙の外の綴りへ戻す変異が全件緑のまま通った）
      const parent = node.parent;
      if (parent !== undefined && ts.isPropertyAssignment(parent) && parent.name === node) return;
      found.add(node.text);
    });
  }
  return found;
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
        // console のログ呼び出しだけを見る（実際にログへ出る実引数を受け取る）
        const args = consoleLogArguments(node);
        if (args === null) return;
        inspected += 1;
        for (const argument of args) {
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
        `${FORMAT_LOG_LINE}(...) だけ (例外の message には PII や接続情報が載る)`,
    ).toEqual([]);
  });

  /**
   * **その名前を名乗れるのは所有モジュールだけ**、を固定する。
   * 許可リストは名前を信頼しているので、名前の出自を縛らないと囮モジュールへ差し替えられる。
   * @param name 縛る名前
   * @param owner その名前を宣言してよい唯一のファイル（絶対パス）
   */
  function expectNameOwnedBy(name: string, owner: string): void {
    // 所有モジュールが実在すること (fail-closed)
    expect(
      SOURCES.some(({ path }) => path === owner),
      `${name} の所有モジュールが無い`,
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
          node.name.text === name &&
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
        if (!isOwner && ts.isExportSpecifier(node) && node.name.text === name) shadowed = true;
        // **import 以外の束縛**（`const` / `function` / 仮引数）は所有モジュール以外では禁止
        if (
          !isOwner &&
          (ts.isVariableDeclaration(node) ||
            ts.isFunctionDeclaration(node) ||
            ts.isParameter(node)) &&
          node.name !== undefined &&
          ts.isIdentifier(node.name) &&
          node.name.text === name
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
          node.name.text === name
        )
          shadowed = true;
        // 呼び出し
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === name
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
    expect(offenders, `${name} は所有モジュールのものだけを使う`).toEqual([]);
  }

  it.each([
    [DESCRIBE_ERROR, join(process.cwd(), 'src', 'lib', 'describe-error.ts')],
    [LOG_EVENT, LOG_OWNER],
    [FORMAT_LOG_LINE, LOG_OWNER],
  ])('%s という名前の出自は所有モジュールだけ', (name, owner) => {
    // 3 つとも「許可リストが名前を信頼している」関数なので、同じ縛りを掛ける
    expectNameOwnedBy(name, owner);
  });

  it('console を呼べるのは出口のモジュールだけ', () => {
    // **これが規則の中心**。以前は「実引数が安全な形なら、どのファイルからでも console を
    // 呼んでよい」だったので、文言は人間向けの散文のままで、出来事の種類で集計も警報も作れなかった。
    // 出口を 1 本に閉じると、呼び出し側が渡せるのは閉じた語彙のキーだけになる（下の it）
    const offenders: string[] = [];
    // 実際に見た console のログ呼び出しの件数（0 なら走査が空振りしている）
    let inspected = 0;
    for (const { path, source } of SOURCES)
      forEachNode(source, (node) => {
        // console のログ呼び出しでなければ関係ない
        if (consoleLogArguments(node) === null) return;
        inspected += 1;
        // 出口のモジュール以外で呼んでいれば違反
        if (path !== LOG_OWNER) offenders.push(path.slice(process.cwd().length + 1));
      });
    // 1 件も見ていなければ走査が壊れている (fail-closed)
    expect(inspected, 'console のログ呼び出しを 1 つも見つけられない').toBeGreaterThan(0);
    // 違反があれば直し方まで文言に書く
    expect(
      [...new Set(offenders)],
      `console を直接呼ばず ${LOG_EVENT}('<${Object.keys(LOG_EVENTS)[0]} のような語彙のキー>') を使う ` +
        '(出口が 1 本だと、出来事の種類で集計・警報を作れる)',
    ).toEqual([]);
  });

  it(`ログの出口の実引数は語彙のキーと ${DESCRIBE_ERROR}(...) だけ`, () => {
    // 規約を破っている箇所
    const offenders: string[] = [];
    // 実際に見た呼び出しの件数（0 なら走査が空振りしている）
    let inspected = 0;
    for (const { path, source } of SOURCES) {
      // **出口を所有するモジュール自身は対象外。** あのファイルの中では間引く側が
      // 毎回出す側へ転送するので、第 1 引数は必ず変数になる（`console` を呼べるのが
      // あのファイルだけなのと同じ理由で、実装の内側は規約の対象にしない）。
      // 呼び出し側（`src` の他のファイル）が変数を渡す形は引き続き落ちる
      if (path === LOG_OWNER) continue;
      forEachNode(source, (node) => {
        // **出口の表から導いて**どれかの呼び出しを探す（名前を決め打つと 2 つ目が素通りする）
        const outlet = Object.keys(LOG_OUTLETS).find(
          (name) => namedCallArguments(node, name) !== null,
        );
        if (outlet === undefined) return;
        // その出口の実引数（**包みを剥がしてから**。理由は namedCallArguments）
        const args = namedCallArguments(node, outlet);
        if (args === null) return;
        inspected += 1;
        // 置き場所を失敗文言に出すための見出し
        const where = `${path.slice(process.cwd().length + 1)}: ${node
          .getText()
          .replace(/\s+/g, ' ')
          .slice(0, 80)}`;
        // 第 1 引数は**語彙に実在するキーの文字列リテラル**だけ（変数だと語彙の網羅を照合できない）
        const first = args[0];
        if (
          first === undefined ||
          !ts.isStringLiteralLike(first) ||
          !Object.hasOwn(LOG_EVENTS, first.text)
        )
          offenders.push(`${where} (第 1 引数が語彙のキーのリテラルでない)`);
        // 第 2 引数は `describeError(...)` だけ（例外に触れてよいのは相変わらずあの関数だけ）
        const second = args[1];
        if (
          second !== undefined &&
          !(
            ts.isCallExpression(second) &&
            ts.isIdentifier(second.expression) &&
            second.expression.text === DESCRIBE_ERROR
          )
        )
          offenders.push(`${where} (第 2 引数が ${DESCRIBE_ERROR}(...) でない)`);
        // 出口ごとの上限を超えたら落とす（型でも拒むが、署名を広げる変更を構文で止める）
        const maxArgs = LOG_OUTLETS[outlet] ?? 0;
        if (args.length > maxArgs) offenders.push(`${where} (実引数が多い: ${outlet})`);
      });
    }
    // 1 件も見ていなければ走査が壊れている (fail-closed)
    expect(inspected, 'ログの出口の呼び出しを 1 つも見つけられない').toBeGreaterThan(0);
    // 違反があれば落とす
    expect(offenders, `ログの出口に渡せるのは語彙のキーと ${DESCRIBE_ERROR}(...) だけ`).toEqual([]);
  });

  it('語彙に宣言した出来事はどれも実際に出している', () => {
    // **宣言だけして使わない値を置かない**（`src/domain/audit/action.ts` と同じ流儀）。
    // 使われない語彙は「この出来事は監視できる」という誤解を生み、警報の条件が永久に空振りする
    const emitted = new Set<string>();
    for (const { source } of SOURCES)
      forEachNode(source, (node) => {
        // `logEvent('<キー>')` の第 1 引数を集める。**実引数の取り出しは
        // `namedCallArguments` に任せる** — 素の識別子の呼び出しだけを見ていた版は、
        // 同じファイルが実引数の形の検査のために剥がしている包み方（`(0, logEvent)(...)` /
        // `.call` / `Reflect.apply`）をここでは剥がしておらず、**同じ 1 つの網の片方だけが
        // 緩い写し**になっていた（倒れる向きは誤った赤だが、写しは必ずどちらかが古くなる）
        // **出口の表から導く**（片方だけを見ると、その出口からしか出さない出来事が
        // 「宣言だけで出していない」と誤って報告される）
        for (const name of Object.keys(LOG_OUTLETS)) {
          const args = namedCallArguments(node, name);
          if (args === null) continue;
          const first = args[0];
          if (first !== undefined && ts.isStringLiteralLike(first)) emitted.add(first.text);
        }
      });
    // **出口の所有モジュールが自分で名乗る分も数える。** `formatLogLine` は整形が失敗した
    // ときに「ログの出口自身が縮退した」という行を出すが、それは自分の出口を通らない
    // （通せば同じ理由で投げうる）。語彙の中の綴りとして `src/lib/log.ts` に書いてあれば
    // 出していると認める — 認めないと、**その行を語彙の外の綴りにする**しかなくなり、
    // 運用者が `LOG_EVENTS` から警報を組めない行が生まれる（それが直前の状態だった）
    for (const literal of ownerEventLiterals()) emitted.add(literal);
    // 語彙が空なら走査が壊れている (fail-closed)
    expect(Object.keys(LOG_EVENTS).length, '語彙が空').toBeGreaterThan(0);
    // 出していないキーを並べる
    expect(
      Object.keys(LOG_EVENTS).filter((event) => !emitted.has(event)),
      '語彙にあるのに src のどこからも出していない出来事がある',
    ).toEqual([]);
  });
});
