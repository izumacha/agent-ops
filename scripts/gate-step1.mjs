#!/usr/bin/env node
// Step1 の受け入れ基準を機械的に検査するゲート (docs/roadmap.md)。赤なら次 Step のブランチを切らない。
//   1. Step0 の項目 (gen / db:generate / lint / format:check / typecheck) が通る
//   2. ユニット + API テストが 60 件以上 pass (失敗 0)
//   3. 権限違反テストが役割 3 × 操作 3 の全パターン存在し、すべて pass (tests/api/rbac-matrix.test.ts)
//   4. `npm audit --audit-level=high` が high 0
// ファイル操作 (Node 標準)
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
// 一時ディレクトリ (Node 標準)
import { tmpdir } from 'node:os';
// パス結合 (Node 標準)
import { join } from 'node:path';
// Step0 の検証コマンド一覧 (写しを持たず再利用する)
import { STEP0_STEPS } from './lib/step0-steps.mjs';
// 共通の実行ヘルパー
import { banner, exitIfFailures, runNpm, runSteps } from './lib/run-npm-steps.mjs';
// 受け入れ基準の判定 (純粋関数。挙動は tests/gate-scripts.test.ts が固定する)
import { evaluateStep1Report } from './lib/gate-report.mjs';

// 受け入れ基準: テスト件数の下限
const REQUIRED_PASSED_TESTS = 60;
// 受け入れ基準: 権限違反テストの全パターン (役割 3 × 操作 3)。役割と操作の一覧そのものは
// src/domain/rbac.ts が正本で、tests/rbac.test.ts が enum との網羅を固定する。ここは基準の文言どおり 3 × 3 を数える
const ROLES = ['viewer', 'operator', 'admin'];
const ACTIONS = ['view', 'execute', 'stop'];
// RBAC 行列テストの名前の接頭辞 (tests/api/rbac-matrix.test.ts と一致させる)
const MATRIX_TEST_PREFIX = 'RBAC 行列: ';

// 1. Step0 の項目のうちテスト以外を流す (テストは JSON レポート付きで別に流す)
runSteps(
  'gate:step1',
  STEP0_STEPS.filter((step) => step.args[1] !== 'test'),
);

// 2. テストを JSON レポート付きで流す
banner('Unit + API tests (JSON レポート付き)');
// レポートの置き場 (一時ディレクトリ。終わったら消す)
const reportDir = mkdtempSync(join(tmpdir(), 'agent-ops-gate-step1-'));
const reportPath = join(reportDir, 'vitest.json');
// vitest run --reporter=default --reporter=json --outputFile=<path>
const testStatus = runNpm([
  'run',
  'test',
  '--',
  '--reporter=default',
  '--reporter=json',
  `--outputFile=${reportPath}`,
]);
// レポートを読む (テストが落ちていても件数の内訳を出す)。process.exit は finally の後で呼ぶ
// (catch の中で exit すると finally が走らず一時ディレクトリが残る)
let report;
let reportError;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
  reportError = error;
} finally {
  rmSync(reportDir, { recursive: true, force: true });
}
// 読めなければ赤
if (reportError !== undefined) {
  console.error(
    '[gate:step1] テストレポートを読めません:',
    reportError instanceof Error ? reportError.message : reportError,
  );
  process.exit(1);
}
// 内訳を表示する
console.log(
  `\n[gate:step1] tests: passed=${report.numPassedTests} failed=${report.numFailedTests} skipped=${report.numPendingTests} (必要: passed >= ${REQUIRED_PASSED_TESTS}, failed = 0)`,
);

// 2'. + 3. テストの成否・件数・RBAC 行列 (役割 3 × 操作 3) をまとめて判定する。
// 判定そのものは純粋関数に置き、ユニットテストで挙動を固定している (scripts/lib/gate-report.mjs)
banner('受け入れ基準の判定 (テスト件数 / RBAC 行列)');
const failures = evaluateStep1Report({
  testStatus,
  report,
  requiredPassedTests: REQUIRED_PASSED_TESTS,
  roles: ROLES,
  actions: ACTIONS,
  matrixPrefix: MATRIX_TEST_PREFIX,
});
// 満たしていない基準があればすべて表示して赤 (終了コードの扱いは run-npm-steps.mjs に集約)
exitIfFailures('gate:step1', failures);
console.log(`[gate:step1] RBAC 行列 ${ROLES.length * ACTIONS.length} パターンすべて pass`);

// 4. npm audit で high 以上が 0 件であること
banner('npm audit (high 0)');
if (runNpm(['audit', '--audit-level=high']) !== 0) {
  console.error('[gate:step1] 失敗: npm audit で high 以上の脆弱性があります');
  process.exit(1);
}

// すべて通った
banner('gate:step1 緑');
