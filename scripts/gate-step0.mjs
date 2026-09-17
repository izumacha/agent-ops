#!/usr/bin/env node
// Step0 の受け入れ基準を機械的に検査するゲート (docs/roadmap.md の「gate:stepN」ルール)。
// 赤なら次 Step のブランチを切らない。検査項目:
//   1. `npm run gen` (OpenAPI → 型生成) が通る
//   2. `npm run db:generate` (Prisma クライアント生成) が通る
//   3. lint / typecheck / test が緑 (OpenAPI 定義の存在と ADR の件数は tests/docs-gate.test.ts が test の中で検査する)
// 子プロセスを同期実行するために使う (Node 標準)
import { spawnSync } from 'node:child_process';

// リポジトリのルート (このスクリプトは npm scripts から呼ばれる前提でカレントを使う)
const ROOT = process.cwd();
// Windows かどうか (npm の起動方法が変わる)
const IS_WINDOWS = process.platform === 'win32';
// 順に実行する検証コマンド (失敗したらその場で止める)
const STEPS = [
  { name: 'OpenAPI 型生成', args: ['run', 'gen'] },
  { name: 'Prisma クライアント生成', args: ['run', 'db:generate'] },
  { name: 'Lint', args: ['run', 'lint'] },
  { name: 'Typecheck', args: ['run', 'typecheck'] },
  { name: 'Unit tests', args: ['run', 'test'] },
];

// 見出しを出す小さなヘルパー
function banner(text) {
  // 区切り線で見やすくする
  console.log(`\n=== ${text} ===`);
}

// コマンドを順番に実行する
for (const step of STEPS) {
  // 何を実行するか表示する
  banner(step.name);
  // npm を子プロセスで実行し、出力はそのまま流す。Windows の npm は .cmd なので shell 経由で起動する
  // (Node 22 は .cmd/.bat の shell 無し spawn を EINVAL で拒否する。引数は固定配列なのでインジェクションの余地は無い)
  const result = spawnSync(IS_WINDOWS ? 'npm.cmd' : 'npm', step.args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: IS_WINDOWS,
  });
  // 非 0 終了なら赤として即終了する
  if (result.status !== 0) {
    console.error(`\n[gate:step0] 失敗: ${step.name}`);
    process.exit(1);
  }
}

// OpenAPI 定義の存在と ADR の件数は tests/docs-gate.test.ts が検査する (上の Unit tests に含まれる)。
// ここに写しを持つと、しきい値を変えたときに片方だけが古くなる

// すべて通った
banner('gate:step0 緑');
