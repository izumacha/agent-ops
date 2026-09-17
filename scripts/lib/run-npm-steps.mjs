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
export function runNpm(args, options = {}) {
  // Windows の npm は .cmd なので shell 経由で起動する
  // (Node 22 は .cmd/.bat の shell 無し spawn を EINVAL で拒否する。引数は固定配列なのでインジェクションの余地は無い)
  const result = spawnSync(IS_WINDOWS ? 'npm.cmd' : 'npm', args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: IS_WINDOWS,
    ...options,
  });
  // 終了コード (シグナル終了などで null なら 1 扱い)
  return result.status ?? 1;
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
