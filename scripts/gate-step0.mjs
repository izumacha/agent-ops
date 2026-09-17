#!/usr/bin/env node
// Step0 の受け入れ基準を機械的に検査するゲート (docs/roadmap.md の「gate:stepN」ルール)。
// 赤なら次 Step のブランチを切らない。検査項目:
//   1. `npm run gen` (OpenAPI → 型生成) が通る
//   2. `npm run db:generate` (Prisma クライアント生成) が通る
//   3. lint / typecheck / test が緑 (OpenAPI 定義の存在と ADR の件数は tests/docs-gate.test.ts が test の中で検査する)
// 共通の実行ヘルパー
import { banner, runSteps } from './lib/run-npm-steps.mjs';

// 順に実行する検証コマンド (失敗したらその場で止める)
export const STEP0_STEPS = [
  { name: 'OpenAPI 型生成', args: ['run', 'gen'] },
  { name: 'Prisma クライアント生成', args: ['run', 'db:generate'] },
  { name: 'Lint', args: ['run', 'lint'] },
  { name: 'Typecheck', args: ['run', 'typecheck'] },
  { name: 'Unit tests', args: ['run', 'test'] },
];

// 直接実行されたときだけゲートを走らせる (gate-step1 が STEP0_STEPS を import して再利用する)
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  // 順に実行する
  runSteps('gate:step0', STEP0_STEPS);
  // OpenAPI 定義の存在と ADR の件数は tests/docs-gate.test.ts が検査する (上の Unit tests に含まれる)。
  // ここに写しを持つと、しきい値を変えたときに片方だけが古くなる
  banner('gate:step0 緑');
}
