#!/usr/bin/env node
// Step2 の受け入れ基準を機械的に検査するゲート (docs/roadmap.md)。赤なら次 Step のブランチを切らない。
//   1. Step0 の項目 (gen / db:generate / lint / format:check / typecheck) が通る
//   2. Step1 の基準を引き継ぐ: テスト 60 件以上 pass (失敗 0) と RBAC 行列 3 × 3
//   3. 料金計算のテストが**料金表の全モデル分**あり pass (受け入れ基準「ベンダー公表単価と誤差 0」)
//   4. `npm audit --audit-level=high` が high 0
//   5. 本番ビルドが通る (ベンチがその成果物を使う)
//   6. ベンチ: 1 万件投入で集計 ≦ 1 秒 / プロキシの追加遅延 ≦ 50ms
//
// **5 と 6 は DB を使う。** `DATABASE_URL` は契約テストと同じ専用 DB (名前が _contract で終わる) を指すこと —
// ベンチは全テーブルを TRUNCATE するので、開発 DB を指していればベンチ側が 1 件も書かずに落ちる
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
import { benchOutputProblems, evaluateStep2Report } from './lib/gate-report.mjs';
// しきい値とテスト名の接頭辞 (ベンチと共有する唯一の定義)
import {
  PRICE_TEST_PREFIX,
  PROXY_ADDED_LATENCY_P95_MAX_MS,
  USAGE_AGGREGATE_MAX_MS,
} from './lib/step2-criteria.mjs';
// Step1 の基準 (件数・RBAC 行列) を引き継ぐ。値を書き写さず、同じ定義を読む
import {
  ACTIONS,
  MATRIX_TEST_PREFIX,
  REQUIRED_PASSED_TESTS,
  ROLES,
} from './lib/step1-criteria.mjs';
// 料金表 (正本) の場所。**期待するテスト名はここから導く** (一覧をゲートに書き写さない)
const VENDOR_PRICES_PATH = join(process.cwd(), 'src', 'domain', 'pricing', 'vendor-prices.json');

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
      '[gate:step2] 料金表を読めません:',
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

// 1. Step0 の項目のうちテスト以外を流す (テストは JSON レポート付きで別に流す)
runSteps(
  'gate:step2',
  STEP0_STEPS.filter((step) => step.args[1] !== 'test'),
);

// 2. テストを JSON レポート付きで流す
banner('Unit + API tests (JSON レポート付き)');
// レポートの置き場 (一時ディレクトリ。終わったら消す)
const reportDir = mkdtempSync(join(tmpdir(), 'agent-ops-gate-step2-'));
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
    '[gate:step2] テストレポートを読めません:',
    reportError instanceof Error ? reportError.message : reportError,
  );
  process.exit(1);
}
// 内訳を表示する
console.log(
  `\n[gate:step2] tests: passed=${report.numPassedTests} failed=${report.numFailedTests} skipped=${report.numPendingTests} (必要: passed >= ${REQUIRED_PASSED_TESTS}, failed = 0)`,
);

// 2'. + 3. テストの成否・件数・RBAC 行列・料金計算の網羅をまとめて判定する
banner('受け入れ基準の判定 (テスト件数 / RBAC 行列 / 料金計算)');
// 料金表のモデル一覧 (正本から導く)
const models = readPricedModels();
// 満たしていない基準があればすべて表示して赤 (終了コードの扱いは run-npm-steps.mjs に集約)。
// **判定の呼び出しをそのまま渡す** — 中間変数を挟むと、宣言と呼び出しの間で再代入 (`failures = []`)
// や破壊的変更 (`failures.length = 0`) ができてしまい、どちらも検出網に映らなかった (実測で全件緑)
exitIfFailures(
  'gate:step2',
  evaluateStep2Report({
    testStatus,
    report,
    requiredPassedTests: REQUIRED_PASSED_TESTS,
    roles: ROLES,
    actions: ACTIONS,
    matrixPrefix: MATRIX_TEST_PREFIX,
    models,
    pricePrefix: PRICE_TEST_PREFIX,
  }),
);
console.log(
  `[gate:step2] RBAC 行列 ${ROLES.length * ACTIONS.length} パターンと料金表 ${models.length} モデルすべて pass`,
);

// 4. npm audit で high 以上が 0 件であること
banner('npm audit (high 0)');
if (runNpm(['audit', '--audit-level=high']) !== 0) {
  console.error('[gate:step2] 失敗: npm audit で high 以上の脆弱性があります');
  process.exit(1);
}

// 5. 本番ビルド (成果物をプロキシのベンチが使うので、ベンチより先に置く)
runSteps('gate:step2', [{ name: '本番ビルド', args: ['run', 'build'] }]);

// 6. ベンチ 2 本。**終了コードだけでなく結果の JSON まで見る** — ベンチの中で基準を強制していても、
// 「何も出さずに exit 0」にできればゲートは緑だった (実測で 3 通りの書き方が全件緑で通った)。
// 実測値と上限の比較もここで独立に行い、ベンチ側の `passed` の写しにしない
banner('ベンチ: 日次集計 (1 万件)');
exitIfFailures(
  'gate:step2',
  benchOutputProblems({
    label: 'usage-aggregate',
    ...runNpmCapturingStdout(['run', 'bench:usage']),
    valueField: 'slowestMs',
    limitField: 'limitMs',
    limit: USAGE_AGGREGATE_MAX_MS,
  }),
);
banner('ベンチ: プロキシの追加遅延');
exitIfFailures(
  'gate:step2',
  benchOutputProblems({
    label: 'proxy-latency',
    ...runNpmCapturingStdout(['run', 'bench:proxy']),
    valueField: 'addedMs',
    limitField: 'limitMs',
    limit: PROXY_ADDED_LATENCY_P95_MAX_MS,
  }),
);

// すべて通った
banner('gate:step2 緑');
