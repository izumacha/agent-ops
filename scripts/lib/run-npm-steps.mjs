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
