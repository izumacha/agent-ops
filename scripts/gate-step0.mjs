#!/usr/bin/env node
// Step0 の受け入れ基準を機械的に検査するゲート (docs/roadmap.md の「gate:stepN」ルール)。
// 赤なら次 Step のブランチを切らない。検査項目:
//   1. `npm run gen` (OpenAPI → 型生成) が通る
//   2. `npm run db:generate` (Prisma クライアント生成) が通る
//   3. lint / typecheck / test が緑
//   4. OpenAPI 定義が存在する
//   5. ADR が 3 件以上ある
// 子プロセスを同期実行するために使う (Node 標準)
import { spawnSync } from 'node:child_process';
// ファイル存在確認とディレクトリ列挙 (Node 標準)
import { existsSync, readdirSync } from 'node:fs';
// パス結合 (Node 標準)
import { join } from 'node:path';

// リポジトリのルート (このスクリプトは npm scripts から呼ばれる前提でカレントを使う)
const ROOT = process.cwd();
// ADR の最低件数 (受け入れ基準)
const REQUIRED_ADRS = 3;
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

// 1〜3: コマンドを順番に実行する
for (const step of STEPS) {
  // 何を実行するか表示する
  banner(step.name);
  // npm を子プロセスで実行し、出力はそのまま流す (Windows では npm.cmd)
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', step.args, {
    cwd: ROOT,
    stdio: 'inherit',
  });
  // 非 0 終了なら赤として即終了する
  if (result.status !== 0) {
    console.error(`\n[gate:step0] 失敗: ${step.name}`);
    process.exit(1);
  }
}

// 4: OpenAPI 定義の存在
banner('OpenAPI 定義');
// 定義ファイルの場所
const openapiPath = join(ROOT, 'openapi', 'openapi.yaml');
// 無ければ赤
if (!existsSync(openapiPath)) {
  console.error('[gate:step0] 失敗: openapi/openapi.yaml がありません');
  process.exit(1);
}
console.log('openapi/openapi.yaml あり');

// 5: ADR の件数
banner('ADR');
// docs/adr 配下の「0001-xxx.md」形式のファイルを数える
const adrDir = join(ROOT, 'docs', 'adr');
const adrs = existsSync(adrDir)
  ? readdirSync(adrDir).filter((name) => /^\d{4}-.+\.md$/.test(name))
  : [];
// 足りなければ赤
if (adrs.length < REQUIRED_ADRS) {
  console.error(`[gate:step0] 失敗: ADR が ${adrs.length} 件 (必要: ${REQUIRED_ADRS} 件以上)`);
  process.exit(1);
}
console.log(`ADR ${adrs.length} 件: ${adrs.join(', ')}`);

// すべて通った
banner('gate:step0 緑');
