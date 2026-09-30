#!/usr/bin/env node
// Step3 の受け入れ基準を機械的に検査するゲート (docs/roadmap.md)。赤なら次 Step のブランチを切らない。
//   1. Step0 の項目 (gen / db:generate / lint / format:check / typecheck) が通る
//   2. Step1・Step2 の基準を引き継ぐ: テスト件数・RBAC 行列 3 × 3・料金計算が料金表の全モデル分
//   3. **不正出力の除外テストが、除外理由の全種類ぶん pass している** (受け入れ基準 2)
//   4. `npm audit --audit-level=high` が high 0
//   5. 本番ビルドが通る (プロキシのベンチがその成果物を使う)
//   6. ベンチ 3 本: 日次集計 ≦ 1 秒 / プロキシの追加遅延 ≦ 50ms / **採点の再現率 ≧ 90%** (受け入れ基準 1)
//
// 受け入れ基準 3 (評価失敗時のフォールバック) は、除外理由 judge_unavailable /
// agent_unavailable のテストとして 3 に含まれる (失敗しても実行の記録が残ることを固定している)。
//
// **5 と 6 は DB を使う。** `DATABASE_URL` は契約テストと同じ専用 DB (名前が _contract で終わる) を指すこと
// ファイル操作 (Node 標準)
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
// 一時ディレクトリ (Node 標準)
import { tmpdir } from 'node:os';
// パス結合 (Node 標準)
import { join } from 'node:path';
// Step0 の検証コマンド一覧 (写しを持たず再利用する)
import { STEP0_STEPS } from './lib/step0-steps.mjs';
// 共通の実行ヘルパー
import {
  banner,
  exitIfFailures,
  runNpm,
  runNpmCapturingStdout,
  runSteps,
} from './lib/run-npm-steps.mjs';
// 受け入れ基準の判定 (純粋関数。挙動は tests/gate-scripts.test.ts が固定する)
import { benchOutputProblems, evaluateStep3Report } from './lib/gate-report.mjs';
// Step2 のしきい値とテスト名の接頭辞 (ベンチと共有する唯一の定義)
import {
  PRICE_TEST_PREFIX,
  PROXY_ADDED_LATENCY_P95_MAX_MS,
  USAGE_AGGREGATE_MAX_MS,
} from './lib/step2-criteria.mjs';
// Step3 のしきい値とテスト名の接頭辞
import {
  EVALUATION_BENCH_CASE_COUNT,
  EXCLUSION_TEST_PREFIX,
  maxDisagreedCases,
} from './lib/step3-criteria.mjs';
// Step1 の基準 (件数・RBAC 行列) を引き継ぐ。値を書き写さず、同じ定義を読む
import {
  ACTIONS,
  MATRIX_TEST_PREFIX,
  REQUIRED_PASSED_TESTS,
  ROLES,
} from './lib/step1-criteria.mjs';

// 料金表 (正本) の場所。**期待するテスト名はここから導く** (一覧をゲートに書き写さない)
const VENDOR_PRICES_PATH = join(process.cwd(), 'src', 'domain', 'pricing', 'vendor-prices.json');
// 除外理由の正本 (Prisma スキーマの enum)。**ドメイン側の TypeScript とは
// tests/domain-enums.test.ts が一致を固定している**ので、どちらを読んでも同じ一覧になる
const SCHEMA_PATH = join(process.cwd(), 'prisma', 'schema.prisma');
// 除外理由の enum 名 (スキーマから切り出す鍵)
const EXCLUSION_ENUM_NAME = 'EvaluationExclusionReason';

// 料金表のモデル一覧を読む (読めなければ空。空のときは判定側が fail-closed で落とす)
function readPricedModels() {
  // 正本の JSON を読む
  try {
    // models 配列から provider / model だけを取り出す
    const parsed = JSON.parse(readFileSync(VENDOR_PRICES_PATH, 'utf8'));
    return (parsed.models ?? []).map((entry) => ({
      provider: entry.provider,
      model: entry.model,
    }));
  } catch (error) {
    // 読めなかったことを残す (判定は空配列として落ちる)
    console.error(
      '[gate:step3] 料金表を読めません:',
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

// 除外理由の一覧を Prisma スキーマの enum から読む (読めなければ空 = 判定側が落とす)
function readExclusionReasons() {
  // スキーマを読む
  try {
    // ファイル全体
    const schema = readFileSync(SCHEMA_PATH, 'utf8');
    // 目的の enum のブロックを切り出す
    const block = new RegExp(`enum\\s+${EXCLUSION_ENUM_NAME}\\s*\\{([^}]*)\\}`).exec(schema);
    // 見つからなければ空 (判定側が fail-closed で落とす)
    if (block === null) return [];
    // 行ごとに、行末コメントを落として先頭の識別子だけを取る
    return block[1]
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(line));
  } catch (error) {
    // 読めなかったことを残す
    console.error(
      '[gate:step3] 除外理由を読めません:',
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

// 1. Step0 の項目のうちテスト以外を流す (テストは JSON レポート付きで別に流す)
runSteps(
  'gate:step3',
  STEP0_STEPS.filter((step) => step.args[1] !== 'test'),
);

// 2. テストを JSON レポート付きで流す
banner('Unit + API tests (JSON レポート付き)');
// レポートの置き場 (一時ディレクトリ。終わったら消す)
const reportDir = mkdtempSync(join(tmpdir(), 'agent-ops-gate-step3-'));
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
    '[gate:step3] テストレポートを読めません:',
    reportError instanceof Error ? reportError.message : reportError,
  );
  process.exit(1);
}
// 内訳を表示する
console.log(
  `\n[gate:step3] tests: passed=${report.numPassedTests} failed=${report.numFailedTests} skipped=${report.numPendingTests} (必要: passed >= ${REQUIRED_PASSED_TESTS}, failed = 0)`,
);

// 2'. + 3. テストの成否・件数・RBAC 行列・料金計算・不正出力の除外をまとめて判定する
banner('受け入れ基準の判定 (テスト件数 / RBAC 行列 / 料金計算 / 不正出力の除外)');
// 料金表のモデル一覧 (正本から導く)
const models = readPricedModels();
// 除外理由の一覧 (正本の enum から導く)
const reasons = readExclusionReasons();
// 満たしていない基準があればすべて表示して赤 (終了コードの扱いは run-npm-steps.mjs に集約)
exitIfFailures(
  'gate:step3',
  evaluateStep3Report({
    testStatus,
    report,
    requiredPassedTests: REQUIRED_PASSED_TESTS,
    roles: ROLES,
    actions: ACTIONS,
    matrixPrefix: MATRIX_TEST_PREFIX,
    models,
    pricePrefix: PRICE_TEST_PREFIX,
    reasons,
    exclusionPrefix: EXCLUSION_TEST_PREFIX,
  }),
);
console.log(
  `[gate:step3] RBAC 行列 ${ROLES.length * ACTIONS.length} パターン・料金表 ${models.length} モデル・除外理由 ${reasons.length} 種類すべて pass`,
);

// 4. npm audit で high 以上が 0 件であること
banner('npm audit (high 0)');
if (runNpm(['audit', '--audit-level=high']) !== 0) {
  console.error('[gate:step3] 失敗: npm audit で high 以上の脆弱性があります');
  process.exit(1);
}

// 5. 本番ビルド (成果物をプロキシのベンチが使うので、ベンチより先に置く)
runSteps('gate:step3', [{ name: '本番ビルド', args: ['run', 'build'] }]);

// 6. ベンチ 3 本。**終了コードだけでなく結果の JSON まで見る** (理由は gate-step2.mjs と同じ)
banner('ベンチ: 日次集計 (1 万件)');
exitIfFailures(
  'gate:step3',
  benchOutputProblems({
    // **材料 (status / stdout) は必ずこの展開で運ぶ。** 先頭に置くのは、後ろの項目を
    // 実行時に上書きされないため (検出網もこの並びを要求する)
    ...runNpmCapturingStdout(['run', 'bench:usage']),
    label: 'usage-aggregate',
    valueField: 'slowestMs',
    limitField: 'limitMs',
    limit: USAGE_AGGREGATE_MAX_MS,
  }),
);
banner('ベンチ: プロキシの追加遅延');
exitIfFailures(
  'gate:step3',
  benchOutputProblems({
    ...runNpmCapturingStdout(['run', 'bench:proxy']),
    label: 'proxy-latency',
    valueField: 'addedMs',
    limitField: 'limitMs',
    limit: PROXY_ADDED_LATENCY_P95_MAX_MS,
  }),
);
banner('ベンチ: 採点の再現率 (固定評価セット 100 件を 2 回)');
exitIfFailures(
  'gate:step3',
  benchOutputProblems({
    ...runNpmCapturingStdout(['run', 'bench:evaluation']),
    label: 'evaluation-agreement',
    // **一致率ではなく「食い違った件数」で見る** (共通判定が「実測値 ≦ 上限」の形しか扱わないため)
    valueField: 'disagreedCases',
    limitField: 'limitDisagreedCases',
    limit: maxDisagreedCases(EVALUATION_BENCH_CASE_COUNT),
  }),
);

// すべて通った
banner('gate:step3 緑');
