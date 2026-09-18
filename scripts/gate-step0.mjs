#!/usr/bin/env node
// Step0 の受け入れ基準を機械的に検査するゲート (docs/roadmap.md の「gate:stepN」ルール)。
// 赤なら次 Step のブランチを切らない。検査項目:
//   1. `npm run gen` (OpenAPI → 型生成) が通る
//   2. `npm run db:generate` (Prisma クライアント生成) が通る
//   3. lint / format:check / typecheck / test が緑 (OpenAPI 定義の存在と ADR の件数は tests/docs-gate.test.ts が
//      test の中で検査する)。実際に流す一覧は scripts/lib/step0-steps.mjs が唯一の定義
// このファイルは純粋な入口で、「直接実行されたときだけ動く」ガードは置かない
// (import.meta.filename と process.argv[1] の比較はシンボリックリンク経由のパスで食い違い、何も検査せず緑になる)
// 共通の実行ヘルパー
import { banner, runSteps } from './lib/run-npm-steps.mjs';
// 検証コマンド一覧 (gate-step1 と共有)
import { STEP0_STEPS } from './lib/step0-steps.mjs';

// 順に実行する (失敗したらその場で止める)
runSteps('gate:step0', STEP0_STEPS);
// OpenAPI 定義の存在と ADR の件数は tests/docs-gate.test.ts が検査する (上の Unit tests に含まれる)。
// ここに写しを持つと、しきい値を変えたときに片方だけが古くなる
banner('gate:step0 緑');
