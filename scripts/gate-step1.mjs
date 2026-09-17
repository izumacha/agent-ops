#!/usr/bin/env node
// Step1 の受け入れ基準を機械的に検査するゲート (docs/roadmap.md)。赤なら次 Step のブランチを切らない。
//   1. Step0 の項目 (gen / db:generate / lint / typecheck) が通る
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
import { STEP0_STEPS } from './gate-step0.mjs';
// 共通の実行ヘルパー
import { banner, runNpm, runSteps } from './lib/run-npm-steps.mjs';

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
// レポートを読む (テストが落ちていても件数の内訳を出す)
let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
  console.error(
    '[gate:step1] テストレポートを読めません:',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
} finally {
  rmSync(reportDir, { recursive: true, force: true });
}
// 内訳を表示する
console.log(
  `\n[gate:step1] tests: passed=${report.numPassedTests} failed=${report.numFailedTests} skipped=${report.numPendingTests} (必要: passed >= ${REQUIRED_PASSED_TESTS}, failed = 0)`,
);
// 失敗があれば赤
if (testStatus !== 0 || report.numFailedTests !== 0) {
  console.error('[gate:step1] 失敗: テストが落ちています');
  process.exit(1);
}
// 件数が足りなければ赤
if (report.numPassedTests < REQUIRED_PASSED_TESTS) {
  console.error(`[gate:step1] 失敗: pass したテストが ${REQUIRED_PASSED_TESTS} 件未満です`);
  process.exit(1);
}

// 3. RBAC 行列の全パターンが存在し pass していること
banner('RBAC 行列 (役割 3 × 操作 3)');
// 全テストの (フルネーム, 結果) を平坦化する
const results = report.testResults.flatMap((file) =>
  file.assertionResults.map((test) => ({ name: test.fullName, status: test.status })),
);
// 見つからない・落ちているパターンを集める
const missing = [];
for (const role of ROLES) {
  for (const action of ACTIONS) {
    // 名前に「RBAC 行列: <役割> × <操作>」を含む pass したテストがあるか
    const needle = `${MATRIX_TEST_PREFIX}${role} × ${action}`;
    const hit = results.find((test) => test.name.includes(needle) && test.status === 'passed');
    if (!hit) missing.push(`${role} × ${action}`);
  }
}
// 1 つでも欠けていれば赤
if (missing.length > 0) {
  console.error(`[gate:step1] 失敗: RBAC 行列のテストが不足/失敗: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`[gate:step1] RBAC 行列 ${ROLES.length * ACTIONS.length} パターンすべて pass`);

// 4. npm audit で high 以上が 0 件であること
banner('npm audit (high 0)');
if (runNpm(['audit', '--audit-level=high']) !== 0) {
  console.error('[gate:step1] 失敗: npm audit で high 以上の脆弱性があります');
  process.exit(1);
}

// すべて通った
banner('gate:step1 緑');
