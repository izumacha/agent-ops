// gate:stepN スクリプトが共有する「npm scripts を順に実行する」ヘルパー (scripts/gate-step0.mjs / gate-step1.mjs が使う)
// 子プロセスを同期実行するために使う (Node 標準)
import { spawnSync } from 'node:child_process';

// Windows かどうか (npm の起動方法が変わる)
const IS_WINDOWS = process.platform === 'win32';

// 見出しを出す小さなヘルパー
export function banner(text) {
  // 区切り線で見やすくする
  console.log(`\n=== ${text} ===`);
}

// npm を引数付きで実行し、終了コードを返す (出力はそのまま流す)
export function runNpm(args) {
  // Windows の npm は .cmd なので shell 経由で起動する
  // (Node 22 は .cmd/.bat の shell 無し spawn を EINVAL で拒否する。引数は固定配列と一時ファイルのパスだけなので
  //  インジェクションの余地は無いが、shell 経由では空白を含む引数 (例: ユーザー名に空白があるときの一時パス) が
  //  分割されるため、空白を含む引数だけ二重引用符で囲む)
  const shellArgs = IS_WINDOWS ? args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : args;
  const result = spawnSync(IS_WINDOWS ? 'npm.cmd' : 'npm', shellArgs, {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: IS_WINDOWS,
  });
  // npm 自体を起動できなかった (PATH に無い・実行権限が無い) ときは原因を残す (§6 エラーを握り潰さない)
  if (result.error) console.error(`[gate] npm を起動できません: ${result.error.message}`);
  // 終了コード (シグナル終了・起動失敗で null なら 1 扱い)
  return result.status ?? 1;
}

/**
 * npm を引数付きで実行し、**標準出力を捕まえたうえでそのまま流す**。
 *
 * **なぜ要るか**: ゲートはこれまでベンチの終了コードしか見ていなかった。そのため、ベンチを
 * 「何も出さずに exit 0」にする変異はどれもゲートを緑のまま通した (実測で 3 通り:
 * `process['exit'](0)` / `const { exit } = process;` / 副作用を持つモジュールの import)。
 * 結果の JSON を読めば、静的解析が捉えられなかった形もまとめて落ちる (§11 実行で確かめる)
 * @param {string[]} args npm へ渡す引数
 * @returns {{ status: number, stdout: string }} 終了コードと標準出力
 */
export function runNpmCapturingStdout(args) {
  // Windows の事情は runNpm と同じ
  const shellArgs = IS_WINDOWS ? args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : args;
  const result = spawnSync(IS_WINDOWS ? 'npm.cmd' : 'npm', shellArgs, {
    cwd: process.cwd(),
    // 標準出力だけ捕まえ、エラー出力は そのまま流す (進捗と失敗理由は人が読めるままにする)
    stdio: ['inherit', 'pipe', 'inherit'],
    encoding: 'utf8',
    shell: IS_WINDOWS,
  });
  // 起動できなかったときは原因を残す (§6 エラーを握り潰さない)
  if (result.error) console.error(`[gate] npm を起動できません: ${result.error.message}`);
  // 捕まえた標準出力を人にも見せる (捕まえたぶん黙ってしまわないように)
  const stdout = result.stdout ?? '';
  if (stdout.length > 0) process.stdout.write(stdout);
  // 終了コードと出力
  return { status: result.status ?? 1, stdout };
}

/**
 * 満たしていない基準が 1 つでもあれば、理由をすべて表示して非 0 終了する (ゲートの最後の 1 歩)。
 *
 * **process.exit はこのファイルに集める。** 判定結果を捨てる形はスクリプト本体に書くと 1 行消すだけで
 * 成立し、実測では「必ず落ちるテスト」を置いても `[gate:step1] 失敗: …` を表示したうえで
 * `=== gate:step1 緑 ===` と出て exit 0 になった。ここに置けば子プロセス経由で挙動を固定できる
 * (tests/gate-scripts.test.ts)。
 */
export function exitIfFailures(gateName, failures) {
  // 満たしていない基準が無ければ何もしない
  if (failures.length === 0) return;
  // 理由をすべて表示する (1 つ直すたびに走らせ直さなくて済むように)
  for (const failure of failures) console.error(`[${gateName}] 失敗: ${failure}`);
  // 非 0 終了 (CI はこれを見て赤にする)
  process.exit(1);
}

// 名前付きのステップを順に実行し、失敗したらその場で非 0 終了する
export function runSteps(gateName, steps) {
  // 1 つずつ実行する
  for (const step of steps) {
    // 何を実行するか表示する
    banner(step.name);
    // 実行し、非 0 なら赤として即終了する
    if (runNpm(step.args) !== 0) {
      console.error(`\n[${gateName}] 失敗: ${step.name}`);
      process.exit(1);
    }
  }
}
