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
  // (Node 22 は .cmd/.bat の shell 無し spawn を EINVAL で拒否する。引数は固定配列と一時ファイルのパスだけなので
  //  インジェクションの余地は無いが、shell 経由では空白を含む引数 (例: ユーザー名に空白があるときの一時パス) が
  //  分割されるため、空白を含む引数だけ二重引用符で囲む)
  const shellArgs = IS_WINDOWS ? args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : args;
  const result = spawnSync(IS_WINDOWS ? 'npm.cmd' : 'npm', shellArgs, {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: IS_WINDOWS,
    ...options,
  });
  // npm 自体を起動できなかった (PATH に無い・実行権限が無い) ときは原因を残す (§6 エラーを握り潰さない)
  if (result.error) console.error(`[gate] npm を起動できません: ${result.error.message}`);
  // 終了コード (シグナル終了・起動失敗で null なら 1 扱い)
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
