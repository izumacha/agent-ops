// src 配下の TypeScript を「綴りではなく構文」で走査するための共通部品。
// 正規表現で検出網を書くと、コメントや文字列リテラルを拾って**緩む**方向にも**巻き込む**方向にも壊れる
// (このリポジトリが繰り返し避けている形)。TypeScript のパーサに読ませれば、コメント中の記述は
// トークンにならず、判定を実際の構文に固定できる
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

/**
 * import の指定子を src 配下の絶対パスへ解決する。
 *
 * 対象はパスエイリアス (`@/…`) と相対指定子だけで、パッケージ名 (`next` など) は null を返す
 * — 追いたいのは**自分たちのモジュールの連鎖**で、依存の中身は別の関心事。
 * @param fromFile その指定子を書いているファイルの絶対パス
 * @param specifier import / export の指定子
 * @returns 解決できた絶対パス (できなければ null)
 */
export function resolveSourceSpecifier(fromFile: string, specifier: string): string | null {
  // 解決の起点 (エイリアスなら src から、相対ならそのファイルのディレクトリから)
  const base = specifier.startsWith('@/')
    ? join(SRC_DIR, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(fromFile), specifier)
      : null;
  // パッケージ名は対象外
  if (base === null) return null;
  // 拡張子は書かれないので、ファイルかディレクトリの index かを順に試す。
  // **`index.tsx` も候補に入れる** — 入れていなかった頃は、モジュールがディレクトリ化されて
  // 入口が `index.tsx`（Client Component を含む束ね）になった瞬間に解決できなくなり、
  // import の連鎖から導く検出網（レート制限の掛け忘れ・`fanOut` の枠）がそのルートを
  // **黙って対象から外したまま緑になる**（`costly.length > 0` の fail-closed は他のルートで
  // 満たされるので発火しない）。Next.js は `.tsx` の index を普通に解決する
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    // 実在する最初の候補を採る
    if (existsSync(candidate)) return candidate;
  }
  // 解決できなかった (型だけの指定子など)
  return null;
}

/**
 * そのファイルが取り込んでいる**自分たちのモジュール**の絶対パスを返す。
 *
 * **指定子は正規表現ではなくパーサから取る** — コメントや文字列リテラルの中の `from '…'` を
 * 拾うと検出網が緩む方向にも巻き込む方向にも壊れる (このファイル冒頭の方針と同じ)。
 * 見るのは静的 import・再公開 (`export … from`)・動的 `import()` の 3 つ。
 * @param parsed 構文木つきのファイル
 * @returns 取り込み先の絶対パス (重複なし)
 */
export function importedModulesOf(parsed: ParsedSourceFile): string[] {
  // 集めた指定子
  const specifiers: string[] = [];
  // 構文木を辿る
  forEachNode(parsed.source, (node) => {
    // 静的 import と再公開は moduleSpecifier を持つ
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
      return;
    }
    // 動的 import は「呼び出し式の関数部分が import キーワード」の形
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
  });
  // 解決できたものだけを重複なしで返す
  return [
    ...new Set(
      specifiers
        .map((specifier) => resolveSourceSpecifier(parsed.path, specifier))
        .filter((path): path is string => path !== null),
    ),
  ];
}

/**
 * src 全体の import グラフを 1 度だけ作る (ファイルごとの取り込み先の表)。
 *
 * **解析済みの一覧を受け取れる。** 既定では自分で `parseSourceFiles()` を呼ぶが、呼び出し側が
 * 同じモジュールで解析結果も使う場合（`tests/route-wrapping.test.ts` / `tests/layering.test.ts`）
 * はそれを渡す — 渡さないと src 全体の TypeScript パースが 1 ファイルあたり 2 度走る。
 * @param parsed 解析済みの src 全体 (省略時はここで解析する)
 * @returns 絶対パス → 取り込み先の絶対パスの一覧
 */
export function sourceImportGraph(
  parsed: ParsedSourceFile[] = parseSourceFiles(),
): Map<string, string[]> {
  // 渡された（または解析した）ファイルごとに取り込み先を集める
  return new Map(parsed.map((file) => [file.path, importedModulesOf(file)]));
}

/**
 * `entry` から import を辿って `target` へ到達できるか (推移的)。
 *
 * **「直接の import だけ」では足りない** — 間に 1 枚挟むだけで検出網から外れる。
 * @param graph sourceImportGraph() の結果 (呼び出しごとに作り直さない)
 * @param entry 起点の絶対パス
 * @param target 到達を調べる絶対パス
 * @returns 到達できれば true (entry 自身は数えない)
 */
export function reachesModule(
  graph: Map<string, string[]>,
  entry: string,
  target: string,
): boolean {
  // 訪問済み (循環 import で止まらなくならないように)
  const seen = new Set<string>();
  // 未訪問の積み
  const stack = [entry];
  // 深さ優先で辿る
  while (stack.length > 0) {
    // 次に見るファイル
    const current = stack.pop() as string;
    // すでに見たら飛ばす
    if (seen.has(current)) continue;
    seen.add(current);
    // 目的地に着いた (起点そのものは数えない)
    if (current === target && current !== entry) return true;
    // 取り込み先を積む
    stack.push(...(graph.get(current) ?? []));
  }
  // 辿り切っても着かなかった
  return false;
}

/**
 * そのファイルがディレクティブ（`'use client'` / `'use server'`）を宣言しているか。
 *
 * **綴りを `grep` で探さない** — コメントや文言の中の同じ綴りまで拾って誤検知する
 * （実際このリポジトリには `'use client'` に言及しているコメントが 3 か所ある）。
 * ディレクティブは「ファイル先頭に並ぶ、式としての文字列リテラルの文」なので構文で見る。
 * @param parsed 構文木つきのファイル
 * @param directive 探すディレクティブ
 * @returns 宣言していれば true
 */
export function declaresDirective(parsed: ParsedSourceFile, directive: string): boolean {
  // 先頭から「式としての文字列リテラルの文」が続く範囲だけを見る
  for (const statement of parsed.source.statements) {
    // 式文でなければディレクティブの並びは終わり
    if (!ts.isExpressionStatement(statement)) return false;
    // 文字列リテラルでなければ同じく終わり
    if (!ts.isStringLiteralLike(statement.expression)) return false;
    // 目的のディレクティブなら見つかった
    if (statement.expression.text === directive) return true;
  }
  // 1 つも無かった
  return false;
}

// --- 呼び出しの包みを剥がす（検出網どうしで共有する） ---
//
// **ここに置いてあるのは、同じ規則を 2 つの検出網が読むため。** `tests/error-logging.test.ts`
// （ログの出口へ渡す実引数の形）と `tests/docs-gate.test.ts`（間引く出口で出す出来事の一覧を
// ソースから導く）が同じ「呼び先の名前」を探す。写しを持つと**片方だけが緩い**状態になり、
// 緩い側はその分だけ取りこぼす（実測で、素の識別子しか見ない版は `(0, f)(…)` /
// `f.call(…)` / `.apply` / `.bind(…)(…)` / `Reflect.apply(f, …)` の 5 形をすべて素通りした）。

// `f.apply(this, [引数])` / `Reflect.apply(f, this, [引数])` の第 3 引数を実引数へ開く
export function spreadArrayArgument(argument: ts.Expression | undefined): readonly ts.Expression[] {
  // 引数が無ければログに出る値も無い
  if (argument === undefined) return [];
  // 配列リテラルなら中身がそのまま実引数（スプレッド要素はその式のまま判定させる）
  if (ts.isArrayLiteralExpression(argument))
    return argument.elements.map((element) =>
      ts.isSpreadElement(element) ? element.expression : element,
    );
  // 配列リテラルでなければ中身を読めないので、その式自体を判定に回す (fail-closed)
  return [argument];
}

// 包みを剥がしながら「元の呼び先」と「包みの種類」「`bind` で先渡しした引数」を取り出す
export function peelCallee(expression: ts.Expression): {
  callee: ts.Expression;
  wrapper: 'call' | 'apply' | 'bind' | null;
  boundArguments: readonly ts.Expression[];
} {
  // 走査中の式と、いちばん外側の包み
  let current: ts.Expression = expression;
  let wrapper: 'call' | 'apply' | 'bind' | null = null;
  const boundArguments: ts.Expression[] = [];
  for (;;) {
    // `( … )`
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    // `a, b` のカンマ式は右端が呼び先
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      current = current.right;
      continue;
    }
    // `f.call` / `f.apply` / `f.bind` は f まで戻る
    if (
      ts.isPropertyAccessExpression(current) &&
      ['call', 'apply', 'bind'].includes(current.name.text)
    ) {
      // いちばん外側の包みだけを覚える（内側は this の付け替えなので実引数を動かさない）
      wrapper ??= current.name.text as 'call' | 'apply' | 'bind';
      current = current.expression;
      continue;
    }
    // `f.bind(console)(…)` のように、剥がした先がさらに呼び出しなら中を見る
    if (ts.isCallExpression(current)) {
      // 呼び先が `f.bind` の形のときだけ辿る（無関係な呼び出しを巻き込まない）
      const inner = current.expression;
      if (ts.isPropertyAccessExpression(inner) && inner.name.text === 'bind') {
        // `bind` の第 2 引数以降は呼び出し時に先頭へ渡される（ログに出る）
        boundArguments.push(...current.arguments.slice(1));
        current = inner.expression;
        continue;
      }
    }
    return { callee: current, wrapper, boundArguments };
  }
}

/**
 * console のログ呼び出しなら「実際にログへ出る実引数」を返す（違えば null）。
 * **包みごとに実引数の位置が違う**ので、剥がした種類に応じて取り出す
 * （`.call` / `.bind` の先頭は this なのでログには出ない。ここを一律に判定へ回していた
 * 版は `console` という識別子を毎回「許していない形」として報告し、失敗文言が嘘になっていた）。
 */
export function callArgumentsFor(
  node: ts.Node,
  isTarget: (expression: ts.Expression) => boolean,
): readonly ts.Expression[] | null {
  // 呼び出しでなければ違う
  if (!ts.isCallExpression(node)) return null;
  // **`Reflect.apply(呼び先, this, [引数])`** — 包みを剥がす経路では届かない形
  const direct = node.expression;
  const isReflectApply =
    ts.isPropertyAccessExpression(direct) &&
    ts.isIdentifier(direct.expression) &&
    direct.expression.text === 'Reflect' &&
    direct.name.text === 'apply';
  if (isReflectApply) {
    // 第 1 引数が呼び先、第 3 引数が実引数の配列
    const target = node.arguments[0];
    if (target === undefined || !isTarget(target)) return null;
    return spreadArrayArgument(node.arguments[2]);
  }
  // 括弧・カンマ式・`.call` / `.apply` / `.bind` を剥がしてから呼び先を見る — 実測で
  // `console.error.call(console, …)` / `.apply` / `.bind(console)(…)` /
  // `(0, console.error)(…)` / `(console.error)(…)` の 5 形がどれも素通りした。
  // `.call` / `.apply` は Prettier も ESLint も書き換えないので、`console[m]` と違って
  // 「意図的に迂回した形」には見えない = レビューを通りやすい
  const peeled = peelCallee(direct);
  if (!isTarget(peeled.callee)) return null;
  // 包みの種類ごとに、呼び先へ届く実引数を取り出す
  if (peeled.wrapper === 'call') return [...peeled.boundArguments, ...node.arguments.slice(1)];
  if (peeled.wrapper === 'apply')
    return [...peeled.boundArguments, ...spreadArrayArgument(node.arguments[1])];
  return [...peeled.boundArguments, ...node.arguments];
}

/**
 * 素の名前の関数の呼び出しなら、その関数へ届く実引数を返す（違えば null）。
 *
 * **`console` と同じ 5 形の包みを剥がす。** 素の識別子だけを見ていた版では、
 * `(logEvent)(…)` / `(0, logEvent)(…)` / `logEvent.call(…)` / `.apply` /
 * `Reflect.apply(logEvent, …)` の**どれを書いてもこの検査から外れた**（実測）。
 * しかも `logEvent` の第 2 引数の型は `Record<string, unknown>` で `describeError` の
 * 戻り値と同じなので、**型も止めない** — 例外の `message` を詰めた物をそのまま渡せる。
 * @param node 走査中のノード
 * @param name 呼び先の名前
 * @returns 実引数（その関数の呼び出しでなければ null）
 */
export function namedCallArguments(node: ts.Node, name: string): readonly ts.Expression[] | null {
  // 呼び先が「その名前の素の識別子」であることだけを見る
  return callArgumentsFor(
    node,
    (expression) => ts.isIdentifier(expression) && expression.text === name,
  );
}
