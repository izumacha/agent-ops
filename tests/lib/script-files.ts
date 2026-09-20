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
import { forEachNode } from './source-files';

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

/**
 * そのファイルが、指定した名前の関数を**実際に呼んでいる**かを構文木で確かめる。
 * コメント・文字列リテラルの中の記述はトークンにならないので数えない。
 * @param path 対象ファイルの絶対パス
 * @param functionName 呼び出し先の識別子
 * @returns 呼び出しがあれば true
 */
export function callsFunction(path: string, functionName: string): boolean {
  // 構文木にする (.mjs も JavaScript として読める)
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  // 見つかったかどうか
  let found = false;
  // すべてのノードを辿る
  forEachNode(source, (node) => {
    // 呼び出し式でなければ関係ない
    if (!ts.isCallExpression(node)) return;
    // 呼び出し先が素の識別子で、名前が一致するか
    if (ts.isIdentifier(node.expression) && node.expression.text === functionName) found = true;
  });
  // 結果
  return found;
}
