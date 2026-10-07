#!/usr/bin/env node
// Step7 (リリース準備) の受け入れ基準を機械的に検査するゲート (docs/roadmap.md)。**最後の Step。**
//   1. Step0 の項目 (gen / db:generate / lint / format:check / typecheck) が通る
//   2. Step1〜6 の基準を引き継ぐ: テスト件数・RBAC 行列 3 × 3・料金計算・不正出力の除外・
//      発火・改ざん検知・ガードレールの E2E・突合・越境・冪等性・カバレッジ
//   3. **既知バグ 0** (受け入れ基準④。`docs/known-issues.md` の表が空 ＋ ソースに未解決の欠陥の
//      印が無い。手がかりを 2 つ要求する理由は `scripts/lib/known-issues.mjs`)
//   4. `npm audit --audit-level=high --omit=dev` が high 0 (本番依存のみ。理由は ADR-0004)
//   5. **本番ビルドが通る** (受け入れ基準③。成果物をベンチ・E2E・Lighthouse が使うので先に置く)
//   6. 主要 5 画面の E2E がすべて pass している
//   7. Lighthouse の Performance / Accessibility が 5 画面すべてで 90 点以上
//   8. ベンチ 6 本: 日次集計 ≦ 1 秒 / プロキシの追加遅延 ≦ 50ms / 採点の再現率 ≧ 90% /
//      発火から停止まで ≦ 3 秒 / **配備からデモ動作まで ≦ 5 分 (受け入れ基準①)** /
//      **同時 100 リクエストでエラー率 < 1% (受け入れ基準②)**
//
// **受け入れ基準①の解釈 (ゲート運用ルール 4)**: 基準の文は `docker compose up` から数えるが、
// Docker デーモンが無い機械ではゲートが回らない。そこで CI の `docker-smoke` ジョブが
// `up -d --build` からの実時間を、`bench:demo-ready` が本番ビルドの起動からの実時間を、
// **同じ上限** (`scripts/lib/step7-criteria.mjs` の `DEMO_READY_MAX_MS`) で見る。
// 部分集合のほうが必ず速いので「ゲートが緑でも CI が赤」はありうる (逆は無い)。
//
// **Step6 までと同じく、契約テストが別 DB で CI で緑であることは CI の別ジョブが担保する**
// (共有 DB を TRUNCATE するので直列実行が要り、ユニットと同じ実行に混ぜられない)。
//
// **期待は正本から導く** (種別は Prisma の enum、壊れ方はドメインの定数、画面と越境の手がかりは
// `scripts/lib/stepN-criteria.mjs`)。一覧をここに書き写すと、画面や種別を足した人がテストを
// 書き忘れてもゲートは緑のままになる。
//
// **5〜8 は DB を使う。** `DATABASE_URL` は契約テストと同じ専用 DB (名前が _contract で終わる) を指すこと。
// **E2E と Lighthouse はブラウザを使う** (chromium)。ダウンロードできない環境では
// `PLAYWRIGHT_CHROMIUM_PATH` に既存の実行ファイルを指す
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
import {
  benchOutputProblems,
  e2eOutputProblems,
  evaluateStep7Report,
  lighthouseOutputProblems,
} from './lib/gate-report.mjs';
// 列挙の正本をソースから読む共有モジュール (読み方を Step ごとに書き写さない)
import { readPrismaEnumMembers, readTsConstValues } from './lib/source-enums.mjs';
// Step2 のしきい値とテスト名の接頭辞
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
// Step4 のしきい値とテスト名の手がかり
import {
  FIRING_TEST_PREFIX,
  GUARDRAIL_E2E_TEST_NAME,
  GUARDRAIL_STOP_MAX_MS,
  TAMPER_TEST_PREFIX,
} from './lib/step4-criteria.mjs';
// Step5 のしきい値・画面一覧・テスト名の手がかり
import {
  LIGHTHOUSE_CATEGORIES,
  LIGHTHOUSE_MIN_SCORE,
  LIGHTHOUSE_RUNS,
  RECONCILE_TEST_NAME,
  SCREEN_TEST_PREFIX,
  STEP5_SCREENS,
} from './lib/step5-criteria.mjs';
// Step6 のしきい値とテスト名の手がかり
import {
  COVERAGE_MIN_PERCENT,
  CROSS_TENANT_DERIVATION_TEST_NAME,
  CROSS_TENANT_MIN_CASES,
  CROSS_TENANT_TEST_PREFIX,
  IDEMPOTENCY_MIN_CASES,
  IDEMPOTENCY_TEST_PREFIX,
} from './lib/step6-criteria.mjs';
// Step7 のしきい値 (デモが動くまでの上限・エラー率の上限)
import { CONCURRENCY_MAX_ERROR_PERCENT, DEMO_READY_MAX_MS } from './lib/step7-criteria.mjs';
// 既知バグ 0 の材料を集める共有モジュール (判定は gate-report.mjs が持つ)
import { findKnownBugMarkers, readKnownIssues } from './lib/known-issues.mjs';
// Step1 の基準 (件数・RBAC 行列) を引き継ぐ。値を書き写さず、同じ定義を読む
import {
  ACTIONS,
  MATRIX_TEST_PREFIX,
  REQUIRED_PASSED_TESTS,
  ROLES,
} from './lib/step1-criteria.mjs';

// 料金表 (正本) の場所。**期待するテスト名はここから導く** (一覧をゲートに書き写さない)
const VENDOR_PRICES_PATH = join(process.cwd(), 'src', 'domain', 'pricing', 'vendor-prices.json');
// カバレッジの合計のファイル名 (vitest の json-summary レポータが出す名前)
const COVERAGE_SUMMARY_FILE = 'coverage-summary.json';
// 除外理由の enum 名 (Prisma スキーマから切り出す鍵)
const EXCLUSION_ENUM_NAME = 'EvaluationExclusionReason';
// ルールの種別の enum 名 (同じ)
const RULE_KIND_ENUM_NAME = 'RuleKind';
// 連鎖の壊れ方の正本 (DB に保存しないドメインの語彙なので Prisma スキーマには無い)
const AUDIT_CHAIN_SOURCE = join('src', 'domain', 'audit', 'chain.ts');
// その定数の名前
const AUDIT_CHAIN_BREAK_NAME = 'AuditChainBreak';

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
      '[gate:step7] 料金表を読めません:',
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

// カバレッジの合計を読む (読めなければ null。判定側が fail-closed で落とす)
function readCoverageSummary(path) {
  // vitest が書き出した JSON を読む
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    // 読めなかったことを残す
    console.error(
      '[gate:step7] カバレッジの合計を読めません:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

// 1. Step0 の項目のうちテスト以外を流す (テストは JSON レポート＋カバレッジ付きで別に流す)
runSteps(
  'gate:step7',
  STEP0_STEPS.filter((step) => step.args[1] !== 'test'),
);

// 2. テストを JSON レポート＋カバレッジ付きで流す (**1 回の実行で両方を得る** —
// 2 回流すと所要時間が倍になり、しかも「レポートとカバレッジが別の実行の結果」になる)
banner('Unit + API tests (JSON レポート + カバレッジ)');
// レポートとカバレッジの置き場 (一時ディレクトリ。終わったら消す)。
// **リポジトリ直下の `coverage/` へ出させない** — 出力先をゲートが指定すれば、
// 判定が読むのは「いま流した 1 回の結果」だけになる (前回の実行結果が残っていても拾わない)
const outputDir = mkdtempSync(join(tmpdir(), 'agent-ops-gate-step7-'));
const reportPath = join(outputDir, 'vitest.json');
const coverageDir = join(outputDir, 'coverage');
// vitest run --coverage --coverage.reportsDirectory=<dir> --reporter=default --reporter=json --outputFile=<path>
const testStatus = runNpm([
  'run',
  'test',
  '--',
  '--coverage',
  `--coverage.reportsDirectory=${coverageDir}`,
  '--reporter=default',
  '--reporter=json',
  `--outputFile=${reportPath}`,
]);
// レポートとカバレッジを読む (テストが落ちていても件数の内訳を出す)。process.exit は finally の後で呼ぶ
let report;
let reportError;
let coverageSummary = null;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
  coverageSummary = readCoverageSummary(join(coverageDir, COVERAGE_SUMMARY_FILE));
} catch (error) {
  reportError = error;
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}
// 読めなければ赤
if (reportError !== undefined) {
  console.error(
    '[gate:step7] テストレポートを読めません:',
    reportError instanceof Error ? reportError.message : reportError,
  );
  process.exit(1);
}
// 内訳を表示する
console.log(
  `\n[gate:step7] tests: passed=${report.numPassedTests} failed=${report.numFailedTests} skipped=${report.numPendingTests} (必要: passed >= ${REQUIRED_PASSED_TESTS}, failed = 0)`,
);

// 3. 前 Step の項目 ＋ 越境・冪等性・カバレッジ ＋ 既知バグ 0 をまとめて判定する
banner('受け入れ基準の判定 (前 Step の項目 / 越境 / 冪等性 / カバレッジ / 既知バグ)');
// 料金表のモデル一覧 (正本から導く)
const models = readPricedModels();
// 除外理由の一覧 (正本の enum から導く)
const reasons = readPrismaEnumMembers('gate:step7', EXCLUSION_ENUM_NAME);
// ルールの種別の一覧 (同じ)
const kinds = readPrismaEnumMembers('gate:step7', RULE_KIND_ENUM_NAME);
// 連鎖の壊れ方の一覧 (ドメインの定数から導く)
const breaks = readTsConstValues('gate:step7', AUDIT_CHAIN_SOURCE, AUDIT_CHAIN_BREAK_NAME);
// 既知の問題の文書（表が空か）とソースの印（残っていないか）
const knownIssues = readKnownIssues();
const knownMarkers = findKnownBugMarkers();
// 満たしていない基準があればすべて表示して赤 (終了コードの扱いは run-npm-steps.mjs に集約)
exitIfFailures(
  'gate:step7',
  evaluateStep7Report({
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
    kinds,
    firingPrefix: FIRING_TEST_PREFIX,
    breaks,
    tamperPrefix: TAMPER_TEST_PREFIX,
    e2eTestName: GUARDRAIL_E2E_TEST_NAME,
    reconcileTestName: RECONCILE_TEST_NAME,
    // Step6: 越境アクセス (受け入れ基準 1)。**導出の照合と群の両方**を要求する
    crossTenantDerivationTestName: CROSS_TENANT_DERIVATION_TEST_NAME,
    crossTenantPrefix: CROSS_TENANT_TEST_PREFIX,
    crossTenantMinCount: CROSS_TENANT_MIN_CASES,
    // Step6: Webhook の冪等性 (受け入れ基準 2)
    idempotencyPrefix: IDEMPOTENCY_TEST_PREFIX,
    idempotencyMinCount: IDEMPOTENCY_MIN_CASES,
    // Step6: カバレッジ (受け入れ基準 4)
    coverageSummary,
    coverageMinPercent: COVERAGE_MIN_PERCENT,
    // Step7: 既知バグ 0 (受け入れ基準④)。**文書とソースの印の 2 つを渡す** —
    // 片方だけでは fail-open になる (理由は scripts/lib/known-issues.mjs)
    knownBugs: {
      docProblems: knownIssues.docProblems,
      openIssues: knownIssues.openIssues,
      markerHits: knownMarkers.hits,
      scannedFiles: knownMarkers.scannedFiles,
    },
  }),
);
console.log(
  `[gate:step7] RBAC 行列 ${ROLES.length * ACTIONS.length} パターン・料金表 ${models.length} モデル・除外理由 ${reasons.length} 種類・発火 ${kinds.length} 種別・改ざん検知 ${breaks.length} 種類・ガードレールの E2E 1 本・突合 1 本・越境 ${CROSS_TENANT_MIN_CASES} パターン以上・冪等性 ${IDEMPOTENCY_MIN_CASES} 本以上・カバレッジ 4 指標すべて ${COVERAGE_MIN_PERCENT}% 以上・既知バグ 0 (文書の表が空 ＋ ソースの印 0 件 / ${knownMarkers.scannedFiles} ファイル走査)`,
);

// 4. npm audit で high 以上が 0 件であること
banner('npm audit (high 0)');
if (runNpm(['audit', '--audit-level=high', '--omit=dev']) !== 0) {
  console.error('[gate:step7] 失敗: npm audit で high 以上の脆弱性があります');
  process.exit(1);
}

// 5. 本番ビルド (成果物をベンチ・E2E・Lighthouse が使うので、それらより先に置く)
runSteps('gate:step7', [{ name: '本番ビルド', args: ['run', 'build'] }]);

// 6. 主要 5 画面の E2E。**結果の JSON まで見る** —
// 終了コードだけだと「スイートを空にする」「画面 1 つ分を消す」形が素通りする
banner('E2E: 主要 5 画面');
exitIfFailures(
  'gate:step7',
  e2eOutputProblems({
    // **材料 (status / stdout) は必ずこの展開で運ぶ** (理由は benchOutputProblems と同じ)
    ...runNpmCapturingStdout(['run', 'test:e2e', '--', '--reporter=json']),
    // 期待する画面とテスト名の接頭辞は受け入れ基準の正本から渡す
    screens: STEP5_SCREENS,
    screenPrefix: SCREEN_TEST_PREFIX,
  }),
);
console.log(`[gate:step7] E2E ${STEP5_SCREENS.length} 画面すべて pass`);

// 7. Lighthouse。合格点・カテゴリ・計測回数は正本から渡して独立に比べる
banner('Lighthouse: Performance / Accessibility');
exitIfFailures(
  'gate:step7',
  lighthouseOutputProblems({
    // 材料は展開で運ぶ (上と同じ理由)
    ...runNpmCapturingStdout(['run', 'lighthouse']),
    screens: STEP5_SCREENS,
    categories: LIGHTHOUSE_CATEGORIES,
    minScore: LIGHTHOUSE_MIN_SCORE,
    runs: LIGHTHOUSE_RUNS,
  }),
);
console.log(
  `[gate:step7] Lighthouse ${LIGHTHOUSE_CATEGORIES.join(' / ')} が ${STEP5_SCREENS.length} 画面すべてで ${LIGHTHOUSE_MIN_SCORE} 点以上`,
);

// 8. ベンチ 6 本。**終了コードだけでなく結果の JSON まで見る** (理由は gate-report.mjs)
banner('ベンチ: 日次集計 (1 万件)');
exitIfFailures(
  'gate:step7',
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
  'gate:step7',
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
  'gate:step7',
  benchOutputProblems({
    ...runNpmCapturingStdout(['run', 'bench:evaluation']),
    label: 'evaluation-agreement',
    // **一致率ではなく「食い違った件数」で見る** (共通判定が「実測値 ≦ 上限」の形しか扱わないため)
    valueField: 'disagreedCases',
    limitField: 'limitDisagreedCases',
    limit: maxDisagreedCases(EVALUATION_BENCH_CASE_COUNT),
  }),
);
banner('ベンチ: 発火から停止まで');
exitIfFailures(
  'gate:step7',
  benchOutputProblems({
    ...runNpmCapturingStdout(['run', 'bench:guardrail']),
    label: 'guardrail-stop',
    valueField: 'elapsedMs',
    limitField: 'limitMs',
    limit: GUARDRAIL_STOP_MAX_MS,
  }),
);

banner('ベンチ: 配備からデモ動作まで (受け入れ基準①の部分集合)');
exitIfFailures(
  'gate:step7',
  benchOutputProblems({
    ...runNpmCapturingStdout(['run', 'bench:demo-ready']),
    label: 'demo-ready',
    valueField: 'elapsedMs',
    limitField: 'limitMs',
    limit: DEMO_READY_MAX_MS,
  }),
);
banner('ベンチ: 同時 100 リクエストのエラー率 (受け入れ基準②)');
exitIfFailures(
  'gate:step7',
  benchOutputProblems({
    ...runNpmCapturingStdout(['run', 'bench:concurrency']),
    label: 'concurrency-error-rate',
    // **ここの独立な比較は「≦ 上限」** (共通判定がその形しか扱わない)。基準の文は
    // 「< 1%」なので、**ちょうど 1% の境界を落とすのはベンチ側の判定**
    // (`concurrencyErrorRateProblem`)。その実効性は negative control が固定する
    valueField: 'errorPercent',
    limitField: 'limitErrorPercent',
    limit: CONCURRENCY_MAX_ERROR_PERCENT,
  }),
);

// すべて通った
banner('gate:step7 緑');
