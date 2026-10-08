// ゲートスクリプト (scripts/) の判定そのものを固定する。
//
// ゲートは「受け入れ基準を緩める変更をテスト側だけで通さない」(ADR-0004) ための最後の砦なのに、
// スクリプト本体の中身は誰も検査していなかった。実測では次の 2 つがどちらも全件緑のまま通った:
//   - `if (report.numPassedTests < REQUIRED_PASSED_TESTS)` を `if (false && ...)` にする
//   - runSteps の `process.exit(1)` を外し、lint / typecheck / format の失敗を素通りさせる
// 前者は判定を純粋関数へ出して挙動を直接固定し、後者は実際に子プロセスを起動して終了コードを見る。
// 「判定結果を捨てる」形 (`process.exit(1)` の 1 行削除) も実測で全件緑のまま通り、しかも実際に落ちる
// テストを置いても `=== gate:step1 緑 ===` と出て exit 0 になったので、終了コードの扱いを
// `exitIfFailures` へ集約して同じ子プロセス方式で固定した。
// **呼び出し行ごと消す変異は eslint が捕まえる** — `exitIfFailures` と `failures` が未使用になるため
// (実測で `eslint . --max-warnings=0` が 1 を返す)。`package.json` の lint からその指定を外さないこと
import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
// 子プロセスの起動と終了の判定 (判定の正本は tests/lib/child-process.ts)
import { CHILD_TIMEOUT_MS, expectRan, testBudgetFor } from './lib/child-process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  benchOutputProblems,
  e2eOutputProblems,
  evaluateStep1Report,
  evaluateStep2Report,
  evaluateStep3Report,
  coverageProblems,
  evaluateStep4Report,
  evaluateStep5Report,
  evaluateStep6Report,
  evaluateStep7Report,
  knownBugProblems,
  prefixedGroupProblems,
  lighthouseOutputProblems,
  missingExclusionCases,
  missingFiringCases,
  missingMatrixCases,
  missingPriceCases,
  missingTamperCases,
} from '../scripts/lib/gate-report.mjs';
import { PRICE_TEST_PREFIX } from '../scripts/lib/step2-criteria.mjs';
import {
  ACTIONS,
  MATRIX_TEST_PREFIX,
  REQUIRED_PASSED_TESTS,
  ROLES,
} from '../scripts/lib/step1-criteria.mjs';
import { STEP0_STEPS } from '../scripts/lib/step0-steps.mjs';
import {
  MIN_MEASURED_REQUESTS,
  WARMUP_MAX_MS,
  addedLatencyProblem,
  aggregateLatencyProblem,
  benchCriteriaFields,
  benchCriteriaJudges,
  benchCaseCountProblem,
  benchLabels,
  concurrencyConnectionsProblem,
  concurrencyErrorRateProblem,
  concurrencyRequestsProblem,
  demoAgentsListedProblem,
  demoAuditRowsProblem,
  demoReadyProblem,
  demoStepDefinitionProblem,
  demoStepOrderProblem,
  demoStepsCompletedProblem,
  disagreementProblem,
  injectedVarianceProblem,
  intFromEnv,
  intFromEnvValue,
  judgeBenchPayload,
  measuredRequestsProblem,
  non2xxProblem,
  runBench,
  upstreamRequestsProblem,
  warmupCountProblem,
  warmupLatencyProblem,
} from '../scripts/lib/bench-criteria.mjs';
import {
  PROXY_ADDED_LATENCY_P95_MAX_MS,
  USAGE_AGGREGATE_MAX_MS,
} from '../scripts/lib/step2-criteria.mjs';
// Step7 の受け入れ基準の値と、既知バグ 0 の材料を集める共有モジュール
import {
  CONCURRENCY_CONNECTIONS,
  CONCURRENCY_MAX_ERROR_PERCENT,
  CONCURRENCY_MIN_REQUESTS,
  DEMO_READY_MAX_MS,
  DEMO_STEP_COUNT,
  KNOWN_BUG_MARKERS,
  KNOWN_BUG_MARKER_DIRS,
  KNOWN_BUG_MARKER_EXCLUDED_DIRS,
  KNOWN_ISSUES_DOC,
  KNOWN_ISSUES_HEADING,
} from '../scripts/lib/step7-criteria.mjs';
import {
  SCANNED_EXTENSIONS,
  commentPositions,
  lineCommentOpenersFor,
  findKnownBugMarkers,
  readKnownIssues,
} from '../scripts/lib/known-issues.mjs';
import { DEMO_STEPS, countStepsInOrder } from '../scripts/lib/demo-flow.mjs';
import { EvaluationExclusionReason } from '@/domain/types';
import {
  EVALUATION_BENCH_CASE_COUNT,
  EVALUATION_BENCH_FLIPPED_CASES,
  EXCLUSION_TEST_PREFIX,
  maxDisagreedCases,
} from '../scripts/lib/step3-criteria.mjs';
import {
  FIRING_TEST_PREFIX,
  GUARDRAIL_E2E_TEST_NAME,
  GUARDRAIL_STOP_MAX_MS,
  TAMPER_TEST_PREFIX,
} from '../scripts/lib/step4-criteria.mjs';
import {
  LIGHTHOUSE_CATEGORIES,
  LIGHTHOUSE_MIN_SCORE,
  LIGHTHOUSE_RUNS,
  RECONCILE_TEST_NAME,
  SCREEN_TEST_PREFIX,
  STEP5_SCREENS,
} from '../scripts/lib/step5-criteria.mjs';
import {
  COVERAGE_MIN_PERCENT,
  CROSS_TENANT_DERIVATION_TEST_NAME,
  CROSS_TENANT_MIN_CASES,
  CROSS_TENANT_TEST_PREFIX,
  IDEMPOTENCY_MIN_CASES,
  IDEMPOTENCY_TEST_PREFIX,
} from '../scripts/lib/step6-criteria.mjs';
import {
  auditRowsProblem,
  firedRulesProblem,
  guardrailStopProblem,
  suspendedAgentsProblem,
} from '../scripts/lib/bench-criteria.mjs';
import { readPrismaEnumMembers, readTsConstValues } from '../scripts/lib/source-enums.mjs';
import { AuditChainBreak } from '@/domain/audit/chain';
import { RuleKind } from '@/domain/types';
import {
  SCRIPTS_DIR,
  callsFunction,
  describedNamesWithTests,
  gateScriptNames,
  latestGateScriptName,
  npmInvocationsInSource,
  importSharedModule,
  foreignModuleSpecifiers,
  processExitArguments,
  processUses,
  scriptModulePaths,
  sharedModuleNames,
  topLevelCallArgumentKinds,
  topLevelCallNames,
  topLevelInitializerEffects,
  topLevelStatementKinds,
  importedSharedNames,
  reachableCallNames,
} from './lib/script-files';

// vitest 由来の印と NODE_ENV を落とした env (「テストのときだけ通す」分岐を成立させないため)
function cleanChildEnv(): NodeJS.ProcessEnv {
  // 親の env を写し取る
  const env = { ...process.env };
  // vitest の印をすべて落とす
  for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key];
  // NODE_ENV も本番相当にする (vitest は 'test' を立てたまま子へ継承する)
  env.NODE_ENV = 'production';
  return env;
}

// **素の Node** で runBench を 1 回動かし、その標準出力と終了コードを返す。
// 静的検査は「その綴りがあるか」しか見ないので、基準が本当に強制されているかはこれで確かめる。
// **残る境界**: 渡すのは合成した計測結果なので、**ベンチ本体が何を測って `slowestMs` /
// `addedMs` に入れたか**はここでも静的検査でも見ていない (`Math.max` を `Math.min` にする
// 変異は全件緑で通る)。ベンチ本体は DB と本番ビルドを要するので検査の費用が高く、
// **計測式が変わる差分はレビューで確認する**という扱いにしている (除外表と同じ)
function runBenchInCleanChild(label: string, payload: Record<string, number>): string {
  // 共有モジュールの場所
  const moduleUrl = pathToFileURL(join(SCRIPTS_DIR, 'lib', 'bench-criteria.mjs')).href;
  // import → 計測結果を渡して実行 → 終了コードの印 の順に並べる
  const code = [
    `const { runBench } = await import(${JSON.stringify(moduleUrl)});`,
    `await runBench(${JSON.stringify(label)}, async () => (${JSON.stringify(payload)}));`,
    `console.log('EXIT_CODE=' + String(process.exitCode));`,
  ].join('\n');
  // 実行する
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT,
    encoding: 'utf8',
    env: cleanChildEnv(),
    timeout: CHILD_TIMEOUT_MS,
  });
  // **起動と完走をここで確かめる** — 時間切れだと stdout が空になり、呼び出し側は
  // 「passed: false にならない」のような**起きていない原因**を名指しする
  expectRan(result, 'runBenchInCleanChild');
  // 標準出力 (結果の JSON と終了コードの印が入る)
  return result.stdout;
}

// 共有モジュールを**素の Node**で import し、その先へ到達できたかを返す。
// **vitest の印 (`VITEST`) を外して起動する** — 付いたままだと
// `if (process.env.VITEST === undefined) process.exit(0);` のような「テストのときだけ通す」
// 1 行を見逃す (実測でこの形が 773 件すべて緑のまま、ベンチを無出力の exit 0 にできた)
function importsWithoutExiting(modulePath: string): string {
  // import → 到達印 の順に並べる
  const code = [
    `await import(${JSON.stringify(pathToFileURL(modulePath).href)});`,
    `console.log('REACHED_END');`,
  ].join('\n');
  // 実行する (vitest の印と NODE_ENV を落とした env で)
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT,
    encoding: 'utf8',
    env: cleanChildEnv(),
    timeout: CHILD_TIMEOUT_MS,
  });
  // **起動と完走をここで確かめる** — 時間切れだと到達印が出ないので、呼び出し側は
  // 「import の時点でプロセスを終わらせる」と誤って名指しする
  expectRan(result, 'importsWithoutExiting');
  // 標準出力 (到達印が出ていれば import の先へ進めている)
  return result.stdout;
}

// 子プロセスでヘルパーを 1 つ呼び、終了コードと「その後に到達したか」を返す。
// **なぜ子プロセスなのか**: process.exit の有無は戻り値に現れないので、同じプロセス内では確かめられない
function runInChild(statements: string[]): { status: number | null; stdout: string } {
  // ヘルパーの場所 (子プロセスから import する)
  const lib = pathToFileURL(join(ROOT, 'scripts', 'lib', 'run-npm-steps.mjs')).href;
  // import → 呼び出し → 到達印 の順に並べる
  const code = [
    `const { exitIfFailures, runSteps } = await import(${JSON.stringify(lib)});`,
    `void exitIfFailures; void runSteps;`,
    ...statements,
    `console.log('REACHED_END');`,
  ].join('\n');
  // 実行する (npm を起動するステップがあるので余裕を持った上限にする)
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
  });
  // **起動と完走をここで確かめる。** 呼び出し側は「非 0 終了であること」を
  // `not.toBe(0)` で見るが、起動に失敗したり時間切れになると `status` は `null` で
  // `null !== 0` なので**何も測れていない状態で緑**になり、`stdout` も空なので
  // 「到達印が無いこと」まで通ってしまう（ゲートの最も大事な 2 本がこの形だった）
  expectRan(result, 'runInChild');
  // 終了コードと標準出力
  return { status: result.status, stdout: result.stdout };
}

// リポジトリのルート
const ROOT = process.cwd();

// あるゲートが「流すと書いてある」npm の一覧。**本文と、下の子の本数の見積もりが同じ導出を読む**
// （書き写すと、片方だけが古くなったときに「予算は 1 本ぶんなのに 10 本起こす」形へ戻る）
function requiredNpmFor(name: string): string[] {
  // Step0 の既定のステップと、そのゲートのソースに直接書かれた npm の引数を合わせる
  return [
    ...new Set([
      ...STEP0_STEPS.map((step) => step.args[1]),
      ...npmInvocationsInSource(join(SCRIPTS_DIR, name)),
    ]),
  ];
}

// negative control の 1 ケースが起こす子の本数（positive control の 1 本 ＋ 壊す対象の本数）の**上限**。
//
// **数値を書かない。** 対象の本数は Step が進むと増えるので、導出から採って追随させる。
//
// **`Math.max` の展開を素で書かない** — ゲートが 1 本も導けないと `Math.max()` は `-Infinity` を
// 返し、締め切りが `NaN` になって**「上限なし」と同じ**挙動になる（下の検査は
// `Math.max(MAX_SHIM_CHILDREN, 共有モジュールの本数)` を見るので、こちらが `-Infinity` でも
// もう一方の本数で埋まり**気付けない**）。導出が空なら前提が崩れているのでここで落とす
const MAX_SHIM_CHILDREN = (() => {
  // ゲートごとの「positive control の 1 本 ＋ 壊す対象の本数」
  const counts = gateScriptNames().map((name) => 1 + requiredNpmFor(name).length);
  // 1 本も導けていなければ fail-closed（`-Infinity` を締め切りへ流さない）
  if (counts.length === 0)
    throw new Error('ゲートスクリプトを 1 本も導けていない（子の本数の上限が決められない）');
  // 最大の本数
  return Math.max(...counts);
})();

// 子プロセスを起こすテストの `it()` の締め切りについて。
//
// **天井そのものは `testBudgetFor` の中が見張る**（CI の `gate` ジョブの `timeout-minutes` を
// 超える締め切りは作れない。本数をどこから渡しても効くので、新しいテストが黙って
// 検査から外れることが無い）。ここで見るのは**この repo で実際にいちばん子を多く起こす 2 形**が
// その天井に収まっていること — 導出（negative control の行列・共有モジュールの import）が
// 壊れて 0 本になる退行も、ここで fail-closed に落ちる。
//
// **どちらも見張っていないもの**: 各 `it()` が渡している本数が、そのテストが実際に起こす本数と
// 合っているか。`testBudgetFor(1)` と書いたまま子を 17 本起こすテストにしても落ちない
// （実際に張り付くまで誰も気付かない）。**子を起こす形を変えたときは渡す本数も直す**のは
// 規約とレビューで守る
describe('子プロセスを起こすテストの締め切り', () => {
  it('いちばん子を多く起こすテストの締め切りが CI のジョブの上限を超えない', () => {
    // 子を起こすテストのうち最大の本数（negative control と共有モジュールの import）
    const widest = Math.max(MAX_SHIM_CHILDREN, sharedModuleNames().length);
    // 1 本も導けていなければ導出が壊れている（fail-closed）
    expect(widest, '子を起こすテストの本数を導けていない').toBeGreaterThan(0);
    // **この呼び出し自体が検査。** `testBudgetFor` は CI の `gate` ジョブの `timeout-minutes` を
    // 超える締め切りを作らず throw するので、「本数 × 子の上限」で積む形へ戻すと
    // ここで落ちる（17 本なら 51.5 分 > 45 分）。
    // **`toBeLessThan(gateJobTimeoutMs())` を書き足さない** — 天井が関数の中にある以上、
    // その比較は必ず成り立つ恒真式になる（何も測らない検査が 1 本増えるだけ）
    expect(testBudgetFor(widest), `子を ${widest} 本起こす締め切りを作れない`).toBeGreaterThan(
      CHILD_TIMEOUT_MS,
    );
  });
});

/**
 * **必ず失敗する `npm` を PATH の先頭に置いて**ゲートを実行し、終了コードと出力を返す。
 *
 * **なぜ要るか（高度の話）**: 「どう書けば `process` へ届くか」を静的に列挙する形では、
 * 綴りを 1 つ塞ぐたびに次の形が出てくる（実測で `globalThis.process` → `globalThis['process']`
 * → 別名束縛 → `globalThis.globalThis.process` → `globalThis[変数]` → `const R = …` を 1 つ挟む
 * → `function(){}.constructor('…')()` と 7 巡続き、どれも全件緑のままゲートを無言で exit 0 に
 * できた）。**綴りに依存しない層で 1 度見る**のがこの検査で、同じ考え方は
 * `importsWithoutExiting`（共有モジュール）と `runBenchInCleanChild`（ベンチ）が既に使っている
 * — **ゲートにだけこの層が無かった**。
 *
 * 見るのは 2 つ: (a) 検証が失敗しているのに 0 で終わらないこと、(b) そもそも `npm` を
 * 呼ぶところまで到達していること（何も検査せず落ちる形も落とす）。
 * **残る境界**: 最初の検証コマンドより後ろでしか走らない場所に隠した終了はここでは見えない
 * @param name ゲートのファイル名 (`gate-step<N>.mjs`)
 * @returns 終了コードと標準出力・標準エラー
 */
/**
 * ゲートを**シムに差し替えた `npm` の下で実際に走らせる**。
 *
 * **なぜ綴りではなく挙動で見るか（高度の話）**: 「どう書けば `process` へ届くか」を静的に
 * 列挙する形は、綴りを 1 つ塞ぐたびに次の形が出た（実測で 8 巡）。しかも射程を「最初の検証
 * コマンドまで」「判定まで」と伸ばすたびに、**同じ変異を数行うしろへ置き直すだけで復活した**。
 *
 * そこで**行列にする**: 他はすべて成功させ、**指定した 1 つの検証だけを失敗させて**、
 * ゲートが非 0 で終わることを見る。壊す対象は**ソース（流すと書いてある `npm` の引数）と
 * `STEP0_STEPS`** から導くので表を持たず、しかも「途中で黙って終わる」変異で一緒に縮まない。
 * あわせて**何も壊さなければ 0 で終わる**ことも見る（positive control。これが検査自身の
 * 射程を固定する — 射程が縮めば「壊していないのに落ちる」か「壊したのに落ちない」の
 * どちらかで必ず赤くなる）。
 * @param name ゲートのファイル名 (`gate-step<N>.mjs`)
 * @param target 失敗させる npm のサブコマンド (空文字なら何も壊さない)
 * @param report テストの JSON レポートとして書かせる中身
 * @param benches npm スクリプト名ごとの、ベンチが出す JSON の材料 (ラベル・項目名・上限)
 * @param printed npm スクリプト名ごとに、そのスクリプトが標準出力へ出す中身
 *   (E2E のレポートや Lighthouse の結果のように、ゲートが**出力を読んで**判定するもの)
 * @param coverage カバレッジの合計 (`coverage-summary.json`) として書かせる中身。
 *   ゲートは出力先を `--coverage.reportsDirectory=` で指定するので、シムはその場所へ書く
 * @returns 終了コードと、呼ばれた npm のサブコマンド
 */
function runGateUnderShim(
  name: string,
  target: string,
  report: string,
  benches: Record<string, { label: string; valueField: string; limitField: string; limit: number }>,
  printed: Record<string, string> = {},
  coverage: string = '',
): { status: number | null; invoked: string[] } {
  // シムを置く一時ディレクトリ
  const shimDir = mkdtempSync(join(tmpdir(), 'agent-ops-npm-shim-'));
  try {
    // 呼ばれたサブコマンドを書き出す先
    const logPath = join(shimDir, 'invoked.log');
    // シムの中身 (OS ごとに書き分けるのは起動の 1 行だけにする)
    const shimJs = join(shimDir, 'npm-shim.mjs');
    writeFileSync(
      shimJs,
      `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const key = argv[0] === 'run' ? argv[1] : argv[0];
appendFileSync(${JSON.stringify(logPath)}, key + '\\n');
const target = ${JSON.stringify(target)};
const broken = key === target;
const printed = ${JSON.stringify(printed)}[key];
if (printed !== undefined) {
  // 出力を読んで判定するもの (E2E / Lighthouse)。**壊すときも中身は出す** —
  // 出さないと「読めません」で落ちてしまい、終了コードを見ているかが一度も試されない
  console.log(printed);
  process.exit(broken ? 1 : 0);
}
const bench = ${JSON.stringify(benches)}[key];
if (bench !== undefined) {
  // ベンチは終了コードでなく**結果の JSON** で落ちるので、壊すときは基準を破る値を出す
  console.log(JSON.stringify({
    bench: bench.label,
    [bench.valueField]: broken ? bench.limit * 100 : 1,
    [bench.limitField]: bench.limit,
    passed: !broken,
  }));
  process.exit(0);
}
// **レポートは壊すときも書く** — 書かないとゲートは「レポートを読めません」で落ちてしまい、
// テストの終了コードを見ているか (testStatus の結線) が一度も試されない。
// **カバレッジも同じ** — ゲートが指定した出力先へ書く (指定が消えればここも書かれず赤くなる)
if (key === 'test')
  for (const arg of argv) {
    if (arg.startsWith('--outputFile=')) writeFileSync(arg.slice('--outputFile='.length), ${JSON.stringify(report)});
    const coverage = ${JSON.stringify(coverage)};
    if (coverage !== '' && arg.startsWith('--coverage.reportsDirectory=')) {
      const dir = arg.slice('--coverage.reportsDirectory='.length);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'coverage-summary.json'), coverage);
    }
  }
process.exit(broken ? 1 : 0);
`,
    );
    // POSIX 用の起動 (Node の絶対パスでシムを呼ぶ)
    writeFileSync(
      join(shimDir, 'npm'),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(shimJs)} "$@"\n`,
    );
    // 実行できるようにする
    chmodSync(join(shimDir, 'npm'), 0o755);
    // Windows 用の起動 (npm.cmd が探される)
    writeFileSync(join(shimDir, 'npm.cmd'), `@"${process.execPath}" "${shimJs}" %*\r\n`);
    // vitest の印を落とした env を作る
    const env = cleanChildEnv();
    // **PATH は置き換える (先頭に足さない)** — 足すだけだと、シムを起動できない環境
    // (`tmpdir` が noexec・Windows の `Path` と `PATH` が並ぶ等) で探索が本物の npm へ落ち、
    // 入れ子の本物の検証が走って上限まで止まる。置き換えれば ENOENT で即座に赤くなる。
    // ゲート自身は `process.execPath` (絶対パス) で起動するので PATH には依存しない
    env.PATH = shimDir;
    // ゲートを素の Node で実行する
    const result = spawnSync(process.execPath, [join(SCRIPTS_DIR, name)], {
      cwd: ROOT,
      encoding: 'utf8',
      env,
      timeout: CHILD_TIMEOUT_MS,
    });
    // **起動と完走をここで確かめる** — 時間切れだと status が null になり、呼び出し側は
    // 「失敗を無視して成功終了した (終了コード null)」と誤って名指しする
    expectRan(result, 'runGateUnderShim');
    // 呼ばれたサブコマンド (1 度も呼ばれていなければ空)
    const invoked = existsSync(logPath)
      ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
      : [];
    return { status: result.status, invoked };
  } finally {
    // 一時ディレクトリを片付ける (§8 リソースを確実に解放する)
    rmSync(shimDir, { recursive: true, force: true });
  }
}

// 判定に渡す役割・操作・接頭辞 (ゲート本体と同じ形。ここでは合成入力なので値は何でもよい)
const MATRIX = {
  roles: ['viewer', 'admin'],
  actions: ['view', 'stop'],
  matrixPrefix: 'RBAC 行列: ',
};

// 指定した組み合わせがすべて pass している vitest レポートを組み立てる
function reportWith(options: {
  passed?: number;
  failed?: number;
  cases?: { role: string; action: string; status?: string }[];
}): Record<string, unknown> {
  // 既定はすべての組み合わせが pass
  const cases: { role: string; action: string; status?: string }[] =
    options.cases ??
    MATRIX.roles.flatMap((role) => MATRIX.actions.map((action) => ({ role, action })));
  // vitest の JSON レポートの形に合わせる
  return {
    numPassedTests: options.passed ?? 100,
    numFailedTests: options.failed ?? 0,
    numPendingTests: 0,
    testResults: [
      {
        assertionResults: cases.map((entry) => ({
          fullName: `${MATRIX.matrixPrefix}${entry.role} × ${entry.action} は 403`,
          status: entry.status ?? 'passed',
        })),
      },
    ],
  };
}

describe('missingMatrixCases', () => {
  it('全パターンが pass していれば不足なし', () => {
    // 役割 × 操作がすべて揃っている
    expect(missingMatrixCases(reportWith({}), MATRIX)).toEqual([]);
  });

  it('1 つでも欠ければその組を返す', () => {
    // admin × stop のテストだけ存在しない
    const cases = MATRIX.roles.flatMap((role) =>
      MATRIX.actions
        .filter((action) => !(role === 'admin' && action === 'stop'))
        .map((action) => ({ role, action })),
    );
    expect(missingMatrixCases(reportWith({ cases }), MATRIX)).toEqual(['admin × stop']);
  });

  it('存在しても落ちているテストは「不足」とみなす', () => {
    // 名前はあるが失敗している (件数だけ見ていると素通りする形)
    const cases = MATRIX.roles.flatMap((role) =>
      MATRIX.actions.map((action) => ({
        role,
        action,
        status: role === 'viewer' && action === 'view' ? 'failed' : 'passed',
      })),
    );
    expect(missingMatrixCases(reportWith({ cases }), MATRIX)).toEqual(['viewer × view']);
  });
});

describe('evaluateStep1Report', () => {
  // 判定に渡す共通の材料 (テストごとに 1 項目だけ壊す)
  const base = { testStatus: 0, requiredPassedTests: 60, ...MATRIX };

  it('基準を満たしていれば失敗なし', () => {
    // 100 件 pass・失敗 0・行列も全パターン
    expect(evaluateStep1Report({ ...base, report: reportWith({}) })).toEqual([]);
  });

  it('pass 件数が下限未満なら失敗になる', () => {
    // 59 件では 60 件の基準を満たさない
    const failures = evaluateStep1Report({ ...base, report: reportWith({ passed: 59 }) });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('60 件未満');
  });

  it('ちょうど下限なら通る (境界値)', () => {
    // 60 件は「60 件以上」を満たす
    expect(evaluateStep1Report({ ...base, report: reportWith({ passed: 60 }) })).toEqual([]);
  });

  it('テストが 1 件でも落ちていれば失敗になる', () => {
    // 件数が足りていても失敗があれば赤
    const failures = evaluateStep1Report({ ...base, report: reportWith({ failed: 1 }) });
    expect(failures).toContain('テストが落ちています');
  });

  it('テスト実行の終了コードが非 0 なら失敗になる (レポートが正常でも)', () => {
    // レポートは緑に見えても、実行そのものが失敗していれば赤
    const failures = evaluateStep1Report({ ...base, testStatus: 1, report: reportWith({}) });
    expect(failures).toContain('テストが落ちています');
  });

  it('RBAC 行列が欠けていれば失敗になる', () => {
    // 1 組だけ落として不足を作る
    const cases = [{ role: 'viewer', action: 'view' }];
    const failures = evaluateStep1Report({ ...base, report: reportWith({ cases }) });
    expect(failures.some((message) => message.includes('RBAC 行列'))).toBe(true);
  });
});

// 料金計算のテストの合否を組み立てる (合成入力。実際の料金表とは独立)
const PRICED_MODELS = [
  { provider: 'anthropic', model: 'claude-x' },
  { provider: 'openai', model: 'gpt-x' },
];

// 指定したモデルの「料金: …」テストを持つレポートを組み立てる
function priceReport(
  cases: { provider: string; model: string; status?: string }[],
  base: Record<string, unknown> = reportWith({}),
): Record<string, unknown> {
  // 既存の RBAC 行列のレポートへ、料金のテスト結果を足す
  const testResults = base.testResults as { assertionResults: unknown[] }[];
  return {
    ...base,
    testResults: [
      {
        assertionResults: [
          ...testResults[0].assertionResults,
          ...cases.map((entry) => ({
            fullName: `${PRICE_TEST_PREFIX}${entry.provider} ${entry.model} は公表単価と誤差 0`,
            status: entry.status ?? 'passed',
          })),
        ],
      },
    ],
  };
}

// 除外理由のテスト結果だけを持つレポートを作る (判定が見るのは名前と状態だけ)
function exclusionReport(cases: { reason: string; status?: string }[]): Record<string, unknown> {
  // 「除外: <理由> — …」という実際のテスト名に近い形で組み立てる
  return {
    numPassedTests: cases.length,
    numFailedTests: 0,
    numPendingTests: 0,
    testResults: [
      {
        assertionResults: cases.map((entry) => ({
          fullName: `${EXCLUSION_TEST_PREFIX}${entry.reason} — 説明`,
          status: entry.status ?? 'passed',
        })),
      },
    ],
  };
}

describe('missingExclusionCases', () => {
  // 判定に渡す除外理由 (実在の enum ではなく合成。判定は一覧を受け取るだけなので十分)
  const REASONS = ['unknown_case_id', 'judge_unavailable'];

  it('全種類分が pass していれば不足なし', () => {
    // 2 種類とも pass
    const report = exclusionReport(REASONS.map((reason) => ({ reason })));
    expect(
      missingExclusionCases(report, { reasons: REASONS, exclusionPrefix: EXCLUSION_TEST_PREFIX }),
    ).toEqual([]);
  });

  it('テストの無い理由は不足として返る (理由を足して書き忘れた形)', () => {
    // 1 種類分しかテストが無い
    const report = exclusionReport([{ reason: REASONS[0] }]);
    expect(
      missingExclusionCases(report, { reasons: REASONS, exclusionPrefix: EXCLUSION_TEST_PREFIX }),
    ).toEqual(['judge_unavailable']);
  });

  it('存在しても落ちているテストは「不足」とみなす', () => {
    // 2 種類目が失敗
    const report = exclusionReport([
      { reason: REASONS[0] },
      { reason: REASONS[1], status: 'failed' },
    ]);
    expect(
      missingExclusionCases(report, { reasons: REASONS, exclusionPrefix: EXCLUSION_TEST_PREFIX }),
    ).toEqual(['judge_unavailable']);
  });

  it('接頭辞が一致するだけの別の理由のテストで代用されない', () => {
    // `missing_score` のテストだけがある状態で `missing` を探す (短い側が長い側に当たる形)
    const report = exclusionReport([{ reason: 'missing_score' }]);
    expect(
      missingExclusionCases(report, {
        reasons: ['missing'],
        exclusionPrefix: EXCLUSION_TEST_PREFIX,
      }),
    ).toEqual(['missing']);
  });
});

describe('missingPriceCases', () => {
  it('料金表の全モデル分が pass していれば不足なし', () => {
    // 2 モデルとも pass
    const report = priceReport(PRICED_MODELS);
    expect(
      missingPriceCases(report, { models: PRICED_MODELS, pricePrefix: PRICE_TEST_PREFIX }),
    ).toEqual([]);
  });

  it('テストの無いモデルは不足として返る (モデルを足してテストを書き忘れた形)', () => {
    // 1 モデル分しかテストが無い
    const report = priceReport([PRICED_MODELS[0]]);
    expect(
      missingPriceCases(report, { models: PRICED_MODELS, pricePrefix: PRICE_TEST_PREFIX }),
    ).toEqual(['openai gpt-x']);
  });

  it('存在しても落ちているテストは「不足」とみなす', () => {
    // 2 モデル目が失敗
    const report = priceReport([PRICED_MODELS[0], { ...PRICED_MODELS[1], status: 'failed' }]);
    expect(
      missingPriceCases(report, { models: PRICED_MODELS, pricePrefix: PRICE_TEST_PREFIX }),
    ).toEqual(['openai gpt-x']);
  });

  it('接頭辞が一致するだけの別モデルのテストで代用されない', () => {
    // **実在する綴り** — 料金表には `openai gpt-5` と `openai gpt-5-mini`、
    // `openai gpt-4.1` と `openai gpt-4.1-mini` のように一方が他方の接頭辞になる行がある。
    // 単なる `includes` だと、短い側のテストが 1 件も無くても長い側の名前が当たってしまい、
    // ゲートは緑のまま「誤差 0」を一度も確かめずに通った (実測。料金表の 3 番目と 5 番目の
    // モデルを落としたレポートで基準が満たされてしまうことをレポート側の probe が掘り当てた)
    const models = [
      { provider: 'openai', model: 'gpt-5' },
      { provider: 'openai', model: 'gpt-5-mini' },
    ];
    // 長い側のテストだけがある
    const report = priceReport([{ provider: 'openai', model: 'gpt-5-mini' }]);
    expect(missingPriceCases(report, { models, pricePrefix: PRICE_TEST_PREFIX })).toEqual([
      'openai gpt-5',
    ]);
  });

  it('ドットで続く別モデルのテストでも代用されない', () => {
    // **区切りの種類ごとに試す** — 実測で、境界の文字クラスからドットを外す変異
    // (`/[A-Za-z0-9._-]/` → `/[A-Za-z0-9_-]/`) が 842 件すべて緑を通った。
    // テストが使う対はどちらもハイフン境界で、ドットは誰にも見られていなかった
    const models = [
      { provider: 'openai', model: 'gpt-4' },
      { provider: 'openai', model: 'gpt-4.1' },
    ];
    // 長い側のテストだけがある
    const report = priceReport([{ provider: 'openai', model: 'gpt-4.1' }]);
    expect(missingPriceCases(report, { models, pricePrefix: PRICE_TEST_PREFIX })).toEqual([
      'openai gpt-4',
    ]);
  });

  it('前の出現が境界を満たさなくても、後ろの出現で数える', () => {
    // 1 つの名前の中に needle が 2 回現れ、**前は境界を満たさず後ろだけ満たす**形。
    // 実測で、ループを「最初の出現だけ見る」に変えても 842 件すべて緑だった
    // (誤る向きは fail-closed なので害は小さいが、分岐が無検証のまま残る)
    const models = [{ provider: 'openai', model: 'gpt-5' }];
    const report = {
      numPassedTests: 1,
      numFailedTests: 0,
      numPendingTests: 0,
      testResults: [
        {
          assertionResults: [
            {
              fullName: `${PRICE_TEST_PREFIX}openai gpt-5-mini と ${PRICE_TEST_PREFIX}openai gpt-5 を比べる`,
              status: 'passed',
            },
          ],
        },
      ],
    };
    expect(missingPriceCases(report, { models, pricePrefix: PRICE_TEST_PREFIX })).toEqual([]);
  });

  it('区切りが続く名前なら項目として数える (境界の判定が厳しすぎない)', () => {
    // 接頭辞の直後が空白なら、その項目のテストとして正しく当たること
    const models = [{ provider: 'openai', model: 'gpt-5' }];
    const report = priceReport([{ provider: 'openai', model: 'gpt-5' }]);
    expect(missingPriceCases(report, { models, pricePrefix: PRICE_TEST_PREFIX })).toEqual([]);
  });
});

describe('evaluateStep2Report', () => {
  // 判定に渡す共通の材料
  const base = {
    testStatus: 0,
    requiredPassedTests: 60,
    ...MATRIX,
    models: PRICED_MODELS,
    pricePrefix: PRICE_TEST_PREFIX,
  };

  it('Step1 の基準と料金のテストがすべて揃っていれば失敗なし', () => {
    // RBAC 行列も料金も揃っている
    expect(evaluateStep2Report({ ...base, report: priceReport(PRICED_MODELS) })).toEqual([]);
  });

  it('Step1 の基準 (RBAC 行列) を引き継いでいる', () => {
    // 行列を 1 組だけにする
    const report = priceReport(
      PRICED_MODELS,
      reportWith({ cases: [{ role: 'viewer', action: 'view' }] }),
    );
    const failures = evaluateStep2Report({ ...base, report });
    expect(failures.some((message) => message.includes('RBAC 行列'))).toBe(true);
  });

  it('Step1 の基準 (件数の下限) も引き継いでいる', () => {
    // 59 件では足りない
    const report = priceReport(PRICED_MODELS, reportWith({ passed: 59 }));
    const failures = evaluateStep2Report({ ...base, report });
    expect(failures.some((message) => message.includes('60 件未満'))).toBe(true);
  });

  it('料金のテストが欠けていれば失敗になる', () => {
    // 1 モデル分しか無い
    const failures = evaluateStep2Report({ ...base, report: priceReport([PRICED_MODELS[0]]) });
    expect(failures.some((message) => message.includes('料金計算'))).toBe(true);
  });

  it('料金表からモデルを 1 件も読めなければ失敗になる (照合の空振りを通さない)', () => {
    // models が空 = 正本を読めなかった状態
    const failures = evaluateStep2Report({
      ...base,
      models: [],
      report: priceReport(PRICED_MODELS),
    });
    expect(
      failures.some((message) => message.includes('料金表からモデルを 1 件も読めません')),
    ).toBe(true);
  });
});

describe('evaluateStep3Report', () => {
  // 判定に渡す共通の材料 (Step2 のものに除外理由の一覧を足したもの)
  const REASONS = ['unknown_case_id', 'judge_unavailable'];
  const base = {
    testStatus: 0,
    requiredPassedTests: 60,
    ...MATRIX,
    models: PRICED_MODELS,
    pricePrefix: PRICE_TEST_PREFIX,
    reasons: REASONS,
    exclusionPrefix: EXCLUSION_TEST_PREFIX,
  };

  // RBAC 行列・料金・除外理由をすべて満たすレポートを作る
  const fullReport = (reasons = REASONS): Record<string, unknown> => {
    // 料金までのレポート
    const priced = priceReport(PRICED_MODELS) as {
      testResults: { assertionResults: unknown[] }[];
      numPassedTests: number;
    };
    // 除外理由のテストを足す
    const assertionResults = [
      ...priced.testResults[0].assertionResults,
      ...reasons.map((reason) => ({
        fullName: `${EXCLUSION_TEST_PREFIX}${reason} — 説明`,
        status: 'passed',
      })),
    ];
    return { ...priced, testResults: [{ assertionResults }] };
  };

  it('Step2 の基準と除外のテストがすべて揃っていれば失敗なし', () => {
    // 行列も料金も除外も揃っている
    expect(evaluateStep3Report({ ...base, report: fullReport() })).toEqual([]);
  });

  it('Step2 の基準 (料金計算) を引き継いでいる', () => {
    // 料金のテストを 1 モデル分だけにする
    const priced = priceReport([PRICED_MODELS[0]]) as {
      testResults: { assertionResults: unknown[] }[];
    };
    const report = {
      ...priced,
      testResults: [
        {
          assertionResults: [
            ...priced.testResults[0].assertionResults,
            ...REASONS.map((reason) => ({
              fullName: `${EXCLUSION_TEST_PREFIX}${reason}`,
              status: 'passed',
            })),
          ],
        },
      ],
    };
    const failures = evaluateStep3Report({ ...base, report });
    expect(failures.some((message) => message.includes('料金計算'))).toBe(true);
  });

  it('除外のテストが欠けていれば失敗になる (理由を足して書き忘れた形)', () => {
    // 1 種類分しか無い
    const failures = evaluateStep3Report({ ...base, report: fullReport([REASONS[0]]) });
    expect(failures.some((message) => message.includes('不正出力の除外テスト'))).toBe(true);
  });

  it('除外理由を 1 件も読めなければ失敗になる (照合の空振りを通さない)', () => {
    // reasons が空 = 正本の enum を読めなかった状態
    const failures = evaluateStep3Report({ ...base, reasons: [], report: fullReport() });
    expect(failures.some((message) => message.includes('除外理由を 1 件も読めません'))).toBe(true);
  });
});

describe('evaluateStep4Report', () => {
  // 判定に渡す共通の材料 (Step3 のものに種別・壊れ方・E2E のテスト名を足したもの)
  const REASONS = ['unknown_case_id', 'judge_unavailable'];
  // **種別と壊れ方は正本から取る** — 手書きの一覧にすると、この検査だけが古い一覧を見続ける
  const KINDS = Object.values(RuleKind);
  const BREAKS = Object.values(AuditChainBreak);
  const base = {
    testStatus: 0,
    requiredPassedTests: 60,
    ...MATRIX,
    models: PRICED_MODELS,
    pricePrefix: PRICE_TEST_PREFIX,
    reasons: REASONS,
    exclusionPrefix: EXCLUSION_TEST_PREFIX,
    kinds: KINDS,
    firingPrefix: FIRING_TEST_PREFIX,
    breaks: BREAKS,
    tamperPrefix: TAMPER_TEST_PREFIX,
    e2eTestName: GUARDRAIL_E2E_TEST_NAME,
  };

  // Step4 の基準をすべて満たすレポートを作る (欠かす項目を指定できる)
  const fullReport = (
    options: { kinds?: readonly string[]; breaks?: readonly string[]; e2e?: boolean } = {},
  ): Record<string, unknown> => {
    // 料金までのレポート
    const priced = priceReport(PRICED_MODELS) as {
      testResults: { assertionResults: unknown[] }[];
      numPassedTests: number;
    };
    // 除外理由・発火・改ざん検知・E2E のテストを足す。**発火と改ざん検知は実際の名前の形に似せる** —
    // 改ざん検知は「接頭辞 … 壊れ方 で落ちる」のように手がかりが離れているので、
    // 連続した 1 本の needle では照合できない形になっていることをここで固定する
    const assertionResults = [
      ...priced.testResults[0].assertionResults,
      ...REASONS.map((reason) => ({
        fullName: `${EXCLUSION_TEST_PREFIX}${reason} — 説明`,
        status: 'passed',
      })),
      ...(options.kinds ?? KINDS).map((kind) => ({
        fullName: `${FIRING_TEST_PREFIX}${kind} しきい値を超えたら発火する`,
        status: 'passed',
      })),
      ...(options.breaks ?? BREAKS).map((reason) => ({
        fullName: `${TAMPER_TEST_PREFIX}値を書き換えた行は ${reason} で落ちる`,
        status: 'passed',
      })),
      ...(options.e2e === false
        ? []
        : [{ fullName: `ガードレールの E2E ${GUARDRAIL_E2E_TEST_NAME}`, status: 'passed' }]),
    ];
    return { ...priced, testResults: [{ assertionResults }] };
  };

  it('前 Step の基準と発火・改ざん検知・E2E がすべて揃っていれば失敗なし', () => {
    // 行列・料金・除外・発火・改ざん検知・E2E が揃っている
    expect(evaluateStep4Report({ ...base, report: fullReport() })).toEqual([]);
  });

  it('Step3 の基準 (不正出力の除外) を引き継いでいる', () => {
    // 除外理由を 1 件も読めなかった状態にする (Step3 側の判定が効いているか)
    const failures = evaluateStep4Report({ ...base, reasons: [], report: fullReport() });
    expect(failures.some((message) => message.includes('除外理由を 1 件も読めません'))).toBe(true);
  });

  it('発火のテストが欠けていれば失敗になる (種別を足して書き忘れた形)', () => {
    // 1 種別分しか無い
    const failures = evaluateStep4Report({
      ...base,
      report: fullReport({ kinds: [KINDS[0]] }),
    });
    expect(failures.some((message) => message.includes('発火のテスト'))).toBe(true);
  });

  it('種別を 1 件も読めなければ失敗になる (照合の空振りを通さない)', () => {
    // kinds が空 = 正本の enum を読めなかった状態
    const failures = evaluateStep4Report({ ...base, kinds: [], report: fullReport() });
    expect(failures.some((message) => message.includes('種別を 1 件も読めません'))).toBe(true);
  });

  it('改ざん検知のテストが欠けていれば失敗になる (壊れ方を足して書き忘れた形)', () => {
    // 1 種類分しか無い
    const failures = evaluateStep4Report({
      ...base,
      report: fullReport({ breaks: [BREAKS[0]] }),
    });
    expect(failures.some((message) => message.includes('改ざん検知のテスト'))).toBe(true);
  });

  it('壊れ方を 1 件も読めなければ失敗になる (照合の空振りを通さない)', () => {
    // breaks が空 = 正本の定数を読めなかった状態
    const failures = evaluateStep4Report({ ...base, breaks: [], report: fullReport() });
    expect(failures.some((message) => message.includes('壊れ方を 1 件も読めません'))).toBe(true);
  });

  it('E2E が無ければ失敗になる', () => {
    // E2E のテストだけを落とす
    const failures = evaluateStep4Report({ ...base, report: fullReport({ e2e: false }) });
    expect(failures.some((message) => message.includes('E2E のテスト'))).toBe(true);
  });
});

describe('evaluateStep5Report', () => {
  // Step4 の材料に、Step5 の突合テストの名前を足したもの
  const REASONS = ['unknown_case_id', 'judge_unavailable'];
  const KINDS = Object.values(RuleKind);
  const BREAKS = Object.values(AuditChainBreak);
  const base = {
    testStatus: 0,
    requiredPassedTests: 60,
    ...MATRIX,
    models: PRICED_MODELS,
    pricePrefix: PRICE_TEST_PREFIX,
    reasons: REASONS,
    exclusionPrefix: EXCLUSION_TEST_PREFIX,
    kinds: KINDS,
    firingPrefix: FIRING_TEST_PREFIX,
    breaks: BREAKS,
    tamperPrefix: TAMPER_TEST_PREFIX,
    e2eTestName: GUARDRAIL_E2E_TEST_NAME,
    reconcileTestName: RECONCILE_TEST_NAME,
  };

  // Step5 の基準をすべて満たすレポートを作る (突合テストを落とせる)
  const fullReport = (options: { reconcile?: boolean } = {}): Record<string, unknown> => {
    // 料金までのレポート
    const priced = priceReport(PRICED_MODELS) as {
      testResults: { assertionResults: unknown[] }[];
      numPassedTests: number;
    };
    // 除外・発火・改ざん検知・ガードレールの E2E・突合を足す
    const assertionResults = [
      ...priced.testResults[0].assertionResults,
      ...REASONS.map((reason) => ({
        fullName: `${EXCLUSION_TEST_PREFIX}${reason} — 説明`,
        status: 'passed',
      })),
      ...KINDS.map((kind) => ({
        fullName: `${FIRING_TEST_PREFIX}${kind} しきい値を超えたら発火する`,
        status: 'passed',
      })),
      ...BREAKS.map((reason) => ({
        fullName: `${TAMPER_TEST_PREFIX}値を書き換えた行は ${reason} で落ちる`,
        status: 'passed',
      })),
      { fullName: `ガードレールの E2E ${GUARDRAIL_E2E_TEST_NAME}`, status: 'passed' },
      // **突合は実際の名前と同じく「説明が後ろに続く」形にする** (完全一致を前提にしない)
      ...(options.reconcile === false
        ? []
        : [
            {
              fullName: `ダッシュボード ${RECONCILE_TEST_NAME}（独立に数え直す）`,
              status: 'passed',
            },
          ]),
    ];
    return { ...priced, testResults: [{ assertionResults }] };
  };

  it('前 Step の基準と突合が揃っていれば失敗なし', () => {
    // Step4 までの項目に突合が加わっている
    expect(evaluateStep5Report({ ...base, report: fullReport() })).toEqual([]);
  });

  it('Step4 の基準 (改ざん検知) を引き継いでいる', () => {
    // 壊れ方を 1 件も読めなかった状態にする (Step4 側の判定が効いているか)
    const failures = evaluateStep5Report({ ...base, breaks: [], report: fullReport() });
    expect(failures.some((message) => message.includes('壊れ方を 1 件も読めません'))).toBe(true);
  });

  it('突合テストが無ければ失敗になる (受け入れ基準 3)', () => {
    // 突合だけを落とす
    const failures = evaluateStep5Report({ ...base, report: fullReport({ reconcile: false }) });
    expect(failures.some((message) => message.includes('突合テスト'))).toBe(true);
  });

  it('突合テストが落ちていれば失敗になる', () => {
    // 名前はあるが status が failed
    const report = fullReport() as { testResults: { assertionResults: { status: string }[] }[] };
    const results = report.testResults[0].assertionResults;
    results[results.length - 1].status = 'failed';
    const failures = evaluateStep5Report({ ...base, report });
    expect(failures.some((message) => message.includes('突合テスト'))).toBe(true);
  });

  it('突合テストの名前が無ければ失敗になる (照合の空振りを通さない)', () => {
    // 名前を渡し忘れた状態
    const failures = evaluateStep5Report({
      ...base,
      reconcileTestName: '',
      report: fullReport(),
    });
    expect(failures.some((message) => message.includes('突合テストの名前がありません'))).toBe(true);
  });
});

describe('prefixedGroupProblems', () => {
  // 群の手がかり・下限・表示名 (値は合成入力なので何でもよい)
  const EXPECTATION = { prefix: '群: ', minCount: 3, label: 'テスト群' };

  // 指定した件数の群を持つレポートを作る (落とす 1 件を選べる)
  const reportWithGroup = (count: number, failAt = -1): Record<string, unknown> => ({
    testResults: [
      {
        assertionResults: Array.from({ length: count }, (_v, i) => ({
          fullName: `${EXPECTATION.prefix}ケース ${i}`,
          status: i === failAt ? 'failed' : 'passed',
        })),
      },
    ],
  });

  it('下限以上あって全部 pass していれば失敗なし', () => {
    // 下限ちょうど
    expect(prefixedGroupProblems(reportWithGroup(3), EXPECTATION)).toEqual([]);
  });

  it('件数が下限を割れば失敗になる', () => {
    // 1 件足りない
    const failures = prefixedGroupProblems(reportWithGroup(2), EXPECTATION);
    expect(failures.some((message) => message.includes('2 件しかありません'))).toBe(true);
  });

  it('1 件でも落ちていれば失敗になる (件数だけ見る形を通さない)', () => {
    // 件数は足りているが 1 件 failed
    const failures = prefixedGroupProblems(reportWithGroup(3, 1), EXPECTATION);
    expect(failures.some((message) => message.includes('テストが失敗'))).toBe(true);
  });

  it('手がかりが空なら失敗になる (照合の空振りを通さない)', () => {
    // 接頭辞を渡し忘れた状態。空文字は `includes` で全件に当たるので黙って緑になりうる
    const failures = prefixedGroupProblems(reportWithGroup(3), { ...EXPECTATION, prefix: '' });
    expect(failures.some((message) => message.includes('手がかりがありません'))).toBe(true);
  });

  it('下限が 0 以下なら失敗になる (「1 本も無くても緑」を通さない)', () => {
    // 下限を 0 にした状態
    const failures = prefixedGroupProblems(reportWithGroup(0), { ...EXPECTATION, minCount: 0 });
    expect(failures.some((message) => message.includes('最小件数'))).toBe(true);
  });
});

describe('coverageProblems', () => {
  // 4 指標ぶんの％を持つ合計を作る
  const summaryWith = (pct: Record<string, number>): unknown => ({
    total: Object.fromEntries(
      Object.entries(pct).map(([metric, value]) => [metric, { pct: value }]),
    ),
  });
  // すべて 90% の合計
  const full = { statements: 90, branches: 90, functions: 90, lines: 90 };

  it('4 指標すべてが下限以上なら失敗なし', () => {
    expect(coverageProblems(summaryWith(full), 80)).toEqual([]);
  });

  it('下限ちょうどは合格', () => {
    // 境界値 (「より大きい」で判定していれば落ちる)
    expect(coverageProblems(summaryWith({ ...full, lines: 80 }), 80)).toEqual([]);
  });

  it.each(['statements', 'branches', 'functions', 'lines'])(
    '%s が下限を割れば失敗になる (1 指標だけ見る形を通さない)',
    (metric) => {
      const failures = coverageProblems(summaryWith({ ...full, [metric]: 79 }), 80);
      expect(failures.some((message) => message.includes(metric))).toBe(true);
    },
  );

  it.each(['statements', 'branches', 'functions', 'lines'])(
    '%s が読めなければ失敗になる (「読めないから緑」を通さない)',
    (metric) => {
      // その指標だけ欠けた合計
      const rest = Object.fromEntries(Object.entries(full).filter(([name]) => name !== metric));
      const failures = coverageProblems(summaryWith(rest), 80);
      expect(failures.some((message) => message.includes(`${metric} を読めません`))).toBe(true);
    },
  );

  it('合計そのものが読めなければ失敗になる', () => {
    // 計測が走らなかった状態 (ゲートは null を渡す)
    const failures = coverageProblems(null, 80);
    expect(failures.some((message) => message.includes('合計を読めません'))).toBe(true);
  });

  it('下限が正の数でなければ失敗になる', () => {
    // 下限を 0 にすると「どんな％でも合格」になる
    const failures = coverageProblems(summaryWith(full), 0);
    expect(failures.some((message) => message.includes('下限が正の数ではありません'))).toBe(true);
  });
});

describe('evaluateStep6Report', () => {
  // Step5 までの材料 (値は合成入力)
  const REASONS = ['unknown_case_id'];
  const KINDS = Object.values(RuleKind);
  const BREAKS = Object.values(AuditChainBreak);
  const DERIVATION = '導出と表が一致する';
  const base = {
    testStatus: 0,
    requiredPassedTests: 60,
    ...MATRIX,
    models: PRICED_MODELS,
    pricePrefix: PRICE_TEST_PREFIX,
    reasons: REASONS,
    exclusionPrefix: EXCLUSION_TEST_PREFIX,
    kinds: KINDS,
    firingPrefix: FIRING_TEST_PREFIX,
    breaks: BREAKS,
    tamperPrefix: TAMPER_TEST_PREFIX,
    e2eTestName: GUARDRAIL_E2E_TEST_NAME,
    reconcileTestName: RECONCILE_TEST_NAME,
    crossTenantDerivationTestName: DERIVATION,
    crossTenantPrefix: '越境: ',
    crossTenantMinCount: 2,
    idempotencyPrefix: '冪等性: ',
    idempotencyMinCount: 2,
    coverageSummary: {
      total: {
        statements: { pct: 90 },
        branches: { pct: 90 },
        functions: { pct: 90 },
        lines: { pct: 90 },
      },
    },
    coverageMinPercent: 80,
  };

  // Step6 の基準をすべて満たすレポート (越境・冪等性・導出を個別に落とせる)
  const fullReport = (
    options: { derivation?: boolean; crossTenant?: number; idempotency?: number } = {},
  ): Record<string, unknown> => {
    // 料金までのレポート (Step5 の組み立てと同じ流儀)
    const priced = priceReport(PRICED_MODELS) as {
      testResults: { assertionResults: unknown[] }[];
      numPassedTests: number;
    };
    // Step3〜5 の分を足す
    const assertionResults = [
      ...priced.testResults[0].assertionResults,
      ...REASONS.map((reason) => ({
        fullName: `${EXCLUSION_TEST_PREFIX}${reason} — 説明`,
        status: 'passed',
      })),
      ...KINDS.map((kind) => ({
        fullName: `${FIRING_TEST_PREFIX}${kind} は発火する`,
        status: 'passed',
      })),
      ...BREAKS.map((reason) => ({
        fullName: `${TAMPER_TEST_PREFIX}壊すと ${reason} で落ちる`,
        status: 'passed',
      })),
      { fullName: `ガードレールの E2E ${GUARDRAIL_E2E_TEST_NAME}`, status: 'passed' },
      { fullName: `ダッシュボード ${RECONCILE_TEST_NAME}（数え直す）`, status: 'passed' },
      // Step6: 導出の照合 (落とせる)
      ...(options.derivation === false
        ? []
        : [{ fullName: `テナント越境 ${DERIVATION}`, status: 'passed' }]),
      // Step6: 越境の群 (件数を選べる)
      ...Array.from({ length: options.crossTenant ?? 2 }, (_v, i) => ({
        fullName: `越境: GET /resource-${i} は 404`,
        status: 'passed',
      })),
      // Step6: 冪等性の群 (同じ)
      ...Array.from({ length: options.idempotency ?? 2 }, (_v, i) => ({
        fullName: `冪等性: 再送 ${i}`,
        status: 'passed',
      })),
    ];
    return { ...priced, testResults: [{ assertionResults }] };
  };

  it('前 Step の基準と Step6 の 3 つが揃っていれば失敗なし', () => {
    expect(evaluateStep6Report({ ...base, report: fullReport() })).toEqual([]);
  });

  it('Step5 の基準 (突合) を引き継いでいる', () => {
    // 突合の名前を渡し忘れた状態 (前 Step の判定が効いているか)
    const failures = evaluateStep6Report({ ...base, reconcileTestName: '', report: fullReport() });
    expect(failures.some((message) => message.includes('突合テストの名前がありません'))).toBe(true);
  });

  it('導出の照合が無ければ失敗になる (受け入れ基準 1)', () => {
    // **群は満点のまま**導出だけを落とす — 群しか見ない形をここで落とす
    const failures = evaluateStep6Report({
      ...base,
      report: fullReport({ derivation: false }),
    });
    expect(failures.some((message) => message.includes('越境テストの導出'))).toBe(true);
  });

  it('導出の照合のテスト名が無ければ失敗になる (照合の空振りを通さない)', () => {
    const failures = evaluateStep6Report({
      ...base,
      crossTenantDerivationTestName: '',
      report: fullReport(),
    });
    expect(failures.some((message) => message.includes('導出を確かめるテストの名前'))).toBe(true);
  });

  it('越境の群が下限を割れば失敗になる (受け入れ基準 1)', () => {
    const failures = evaluateStep6Report({ ...base, report: fullReport({ crossTenant: 1 }) });
    expect(failures.some((message) => message.includes('越境アクセス'))).toBe(true);
  });

  it('冪等性の群が下限を割れば失敗になる (受け入れ基準 2)', () => {
    const failures = evaluateStep6Report({ ...base, report: fullReport({ idempotency: 1 }) });
    expect(failures.some((message) => message.includes('冪等性'))).toBe(true);
  });

  it('カバレッジが下限を割れば失敗になる (受け入れ基準 4)', () => {
    const failures = evaluateStep6Report({
      ...base,
      coverageSummary: {
        total: {
          statements: { pct: 90 },
          branches: { pct: 70 },
          functions: { pct: 90 },
          lines: { pct: 90 },
        },
      },
      report: fullReport(),
    });
    expect(failures.some((message) => message.includes('カバレッジの branches'))).toBe(true);
  });

  it('カバレッジが測れていなければ失敗になる', () => {
    // ゲートは読めなかったとき null を渡す
    const failures = evaluateStep6Report({ ...base, coverageSummary: null, report: fullReport() });
    expect(failures.some((message) => message.includes('カバレッジの合計を読めません'))).toBe(true);
  });
});

describe('e2eOutputProblems', () => {
  // 判定に渡す画面一覧 (正本から取る。手書きにするとこの検査だけが古い一覧を見る)
  const SCREENS = STEP5_SCREENS;
  // 5 画面すべてが pass した Playwright のレポート (入れ子の suite 込み)。
  // **`ok` と `tests[].status` の両方を本物と同じ形で入れる** — Playwright は skip された
  // spec にも `ok: true` を書くので、`status` が無いフィクスチャでは「skip を pass と
  // 数える」退行を再現できない
  const fullReport = (options: { drop?: string; fail?: string; skip?: string } = {}): string =>
    JSON.stringify({
      suites: [
        {
          title: 'screens.spec.ts',
          specs: [],
          suites: [
            {
              title: '主要 5 画面',
              specs: SCREENS.filter((screen) => screen.title !== options.drop).map((screen) => ({
                title: `${SCREEN_TEST_PREFIX}${screen.title}`,
                // skip された spec も Playwright は ok: true と書く (TestCase.ok() の仕様)
                ok: screen.title !== options.fail,
                tests: [
                  {
                    status:
                      screen.title === options.fail
                        ? 'unexpected'
                        : screen.title === options.skip
                          ? 'skipped'
                          : 'expected',
                  },
                ],
              })),
            },
          ],
        },
      ],
    });

  it('5 画面すべてが pass していれば失敗なし', () => {
    // 入れ子を辿って spec を見つけられること
    expect(
      e2eOutputProblems({
        status: 0,
        stdout: fullReport(),
        screens: SCREENS,
        screenPrefix: SCREEN_TEST_PREFIX,
      }),
    ).toEqual([]);
  });

  it('終了コードが 0 でなければ失敗になる', () => {
    const failures = e2eOutputProblems({
      status: 1,
      stdout: fullReport(),
      screens: SCREENS,
      screenPrefix: SCREEN_TEST_PREFIX,
    });
    expect(failures.some((message) => message.includes('E2E が失敗しました'))).toBe(true);
  });

  it('画面 1 つ分のテストが無ければ失敗になる (画面を足して書き忘れた形)', () => {
    // 1 画面分の spec を落とす
    const failures = e2eOutputProblems({
      status: 0,
      stdout: fullReport({ drop: SCREENS[0].title }),
      screens: SCREENS,
      screenPrefix: SCREEN_TEST_PREFIX,
    });
    expect(failures.some((message) => message.includes(SCREENS[0].title))).toBe(true);
  });

  it('画面 1 つ分が落ちていれば失敗になる', () => {
    // ok: false の spec がある
    const failures = e2eOutputProblems({
      status: 0,
      stdout: fullReport({ fail: SCREENS[1].title }),
      screens: SCREENS,
      screenPrefix: SCREEN_TEST_PREFIX,
    });
    expect(failures.some((message) => message.includes(SCREENS[1].title))).toBe(true);
  });

  it('skip された画面は pass と数えない (test.skip() で黙らせる形)', () => {
    // **Playwright は skip された spec にも `ok: true` を書く**ので、`ok` だけを見ていた版は
    // 「その画面は一度も動いていないのに 5 画面すべて pass」になっていた (テストの本数も減らない)
    const failures = e2eOutputProblems({
      status: 0,
      stdout: fullReport({ skip: SCREENS[2].title }),
      screens: SCREENS,
      screenPrefix: SCREEN_TEST_PREFIX,
    });
    expect(failures.some((message) => message.includes(SCREENS[2].title))).toBe(true);
  });

  it('実行の記録が無い spec も pass と数えない (レポートを削った形)', () => {
    // `tests` を持たない spec だけのレポート (ok だけを書いた偽の結果)
    const failures = e2eOutputProblems({
      status: 0,
      stdout: JSON.stringify({
        suites: [
          {
            title: '主要 5 画面',
            specs: SCREENS.map((screen) => ({
              title: `${SCREEN_TEST_PREFIX}${screen.title}`,
              ok: true,
            })),
          },
        ],
      }),
      screens: SCREENS,
      screenPrefix: SCREEN_TEST_PREFIX,
    });
    // 5 画面すべてが「不足/失敗」に挙がる
    expect(failures.some((message) => message.includes(SCREENS[0].title))).toBe(true);
  });

  it('spec が 1 本も無ければ失敗になる (スイートを空にする形)', () => {
    // suite はあるが spec が無い
    const failures = e2eOutputProblems({
      status: 0,
      stdout: JSON.stringify({ suites: [{ title: 'screens.spec.ts', specs: [], suites: [] }] }),
      screens: SCREENS,
      screenPrefix: SCREEN_TEST_PREFIX,
    });
    expect(failures.some((message) => message.includes('1 本も走っていません'))).toBe(true);
  });

  it('レポートが読めなければ失敗になる (何も出さずに終わる形)', () => {
    // 標準出力が空
    const failures = e2eOutputProblems({
      status: 0,
      stdout: '',
      screens: SCREENS,
      screenPrefix: SCREEN_TEST_PREFIX,
    });
    expect(failures.some((message) => message.includes('読めません'))).toBe(true);
  });

  it('壊れた JSON は理由を付けて失敗になる', () => {
    // 括弧は揃っているが JSON として読めない
    const failures = e2eOutputProblems({
      status: 0,
      stdout: '{ "suites": [ }',
      screens: SCREENS,
      screenPrefix: SCREEN_TEST_PREFIX,
    });
    expect(failures.some((message) => message.includes('解釈できません'))).toBe(true);
  });

  it('画面一覧が空なら失敗になる (照合の空振りを通さない)', () => {
    const failures = e2eOutputProblems({
      status: 0,
      stdout: fullReport(),
      screens: [],
      screenPrefix: SCREEN_TEST_PREFIX,
    });
    expect(failures.some((message) => message.includes('1 つも読めません'))).toBe(true);
  });

  it('npm の前置きが混ざっても読める', () => {
    // npm run の出力が先に来る形
    expect(
      e2eOutputProblems({
        status: 0,
        stdout: `> agent-ops@0.1.0 test:e2e\n> playwright test\n\n${fullReport()}\n`,
        screens: SCREENS,
        screenPrefix: SCREEN_TEST_PREFIX,
      }),
    ).toEqual([]);
  });
});

describe('lighthouseOutputProblems', () => {
  // 判定に渡す材料 (正本から取る)
  const SCREENS = STEP5_SCREENS;
  const base = {
    screens: SCREENS,
    categories: LIGHTHOUSE_CATEGORIES,
    minScore: LIGHTHOUSE_MIN_SCORE,
    runs: LIGHTHOUSE_RUNS,
  };
  // 全画面が合格点の結果 (1 行の JSON)
  const fullOutput = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      measure: 'lighthouse',
      minScore: LIGHTHOUSE_MIN_SCORE,
      categories: LIGHTHOUSE_CATEGORIES,
      runs: LIGHTHOUSE_RUNS,
      pages: SCREENS.map((screen) => ({
        page: screen.key,
        scores: Object.fromEntries(
          LIGHTHOUSE_CATEGORIES.map((category) => [category, LIGHTHOUSE_MIN_SCORE + 5]),
        ),
      })),
      ...overrides,
    });

  it('全画面が合格点なら失敗なし', () => {
    expect(lighthouseOutputProblems({ ...base, status: 0, stdout: fullOutput() })).toEqual([]);
  });

  it('終了コードが 0 でなければ失敗になる', () => {
    const failures = lighthouseOutputProblems({ ...base, status: 1, stdout: fullOutput() });
    expect(failures.some((message) => message.includes('計測が失敗しました'))).toBe(true);
  });

  it('合格点を下回る画面があれば失敗になる', () => {
    // 1 画面だけ 1 点足りない
    const low = JSON.parse(fullOutput()) as {
      pages: { page: string; scores: Record<string, number> }[];
    };
    low.pages[0].scores[LIGHTHOUSE_CATEGORIES[0]] = LIGHTHOUSE_MIN_SCORE - 1;
    const failures = lighthouseOutputProblems({
      ...base,
      status: 0,
      stdout: JSON.stringify(low),
    });
    expect(failures.some((message) => message.includes(low.pages[0].page))).toBe(true);
  });

  it('測っていない画面があれば失敗になる', () => {
    // 1 画面分の結果が無い
    const partial = JSON.parse(fullOutput()) as { pages: unknown[] };
    partial.pages = partial.pages.slice(1);
    const failures = lighthouseOutputProblems({
      ...base,
      status: 0,
      stdout: JSON.stringify(partial),
    });
    expect(failures.some((message) => message.includes(SCREENS[0].key))).toBe(true);
  });

  it('カテゴリを 1 つしか測っていなければ失敗になる', () => {
    // categories が片方だけ
    const failures = lighthouseOutputProblems({
      ...base,
      status: 0,
      stdout: fullOutput({ categories: [LIGHTHOUSE_CATEGORIES[0]] }),
    });
    expect(failures.some((message) => message.includes('測っていないカテゴリ'))).toBe(true);
  });

  it('合格点が正本と食い違えば失敗になる', () => {
    // 出力側の合格点だけを下げる (どちらかが古い)
    const failures = lighthouseOutputProblems({
      ...base,
      status: 0,
      stdout: fullOutput({ minScore: LIGHTHOUSE_MIN_SCORE - 10 }),
    });
    expect(failures.some((message) => message.includes('minScore'))).toBe(true);
  });

  it('計測回数が正本と食い違えば失敗になる (1 回に減らす形)', () => {
    // 揺れをそのまま判定に持ち込む形を落とす
    const failures = lighthouseOutputProblems({
      ...base,
      status: 0,
      stdout: fullOutput({ runs: 1 }),
    });
    expect(failures.some((message) => message.includes('計測回数'))).toBe(true);
  });

  it('結果の JSON が無ければ失敗になる (何も測らずに終わる形)', () => {
    const failures = lighthouseOutputProblems({ ...base, status: 0, stdout: '' });
    expect(failures.some((message) => message.includes('読めません'))).toBe(true);
  });

  it('結果の JSON が 2 本あれば失敗になる (嘘の行を重ねる形)', () => {
    const failures = lighthouseOutputProblems({
      ...base,
      status: 0,
      stdout: `${fullOutput()}\n${fullOutput()}`,
    });
    expect(failures.some((message) => message.includes('2 本あります'))).toBe(true);
  });

  it('点数が数値でなければ失敗になる', () => {
    // 文字列の点数 ("90" のような形で比較をすり抜けさせない)
    const broken = JSON.parse(fullOutput()) as {
      pages: { page: string; scores: Record<string, unknown> }[];
    };
    broken.pages[0].scores[LIGHTHOUSE_CATEGORIES[0]] = String(LIGHTHOUSE_MIN_SCORE + 5);
    const failures = lighthouseOutputProblems({
      ...base,
      status: 0,
      stdout: JSON.stringify(broken),
    });
    expect(failures.some((message) => message.includes('数値の'))).toBe(true);
  });

  it('材料が欠けていれば失敗になる (比較が無音で消えないように)', () => {
    // 画面一覧が空・カテゴリが空・合格点が無い
    for (const patch of [{ screens: [] }, { categories: [] }, { minScore: undefined }]) {
      const failures = lighthouseOutputProblems({
        ...base,
        ...patch,
        status: 0,
        stdout: fullOutput(),
      } as Parameters<typeof lighthouseOutputProblems>[0]);
      expect(failures.length).toBeGreaterThan(0);
    }
  });

  it('計測が非 0 で終わっていても、材料不足は理由を付けて返す (例外にしない)', () => {
    // **終了コードの失敗と材料不足が同時に起きる場合** — 1 つの配列へ混ぜて
    // 「失敗があり、かつ終了コードが 0 なら返す」としていた版は、この組み合わせで
    // 判定を素通りし `categories.filter` が undefined を触って TypeError になっていた
    // （呼び出し側は理由を 1 つも受け取れず、例外がそのまま外へ出る）
    const failures = lighthouseOutputProblems({
      status: 1,
      stdout: fullOutput(),
      screens: undefined,
      categories: undefined,
      minScore: undefined,
      runs: undefined,
    } as unknown as Parameters<typeof lighthouseOutputProblems>[0]);
    // 終了コードの失敗と、欠けた材料 4 つ分がすべて文言として返る
    expect(failures.some((message) => message.includes('終了コード'))).toBe(true);
    expect(failures.some((message) => message.includes('対象画面'))).toBe(true);
    expect(failures.some((message) => message.includes('対象カテゴリ'))).toBe(true);
    expect(failures.some((message) => message.includes('合格点'))).toBe(true);
    expect(failures.some((message) => message.includes('計測回数'))).toBe(true);
  });
});

describe('missingFiringCases', () => {
  // レポートを 1 本の名前から作る
  const reportOf = (names: string[]): Record<string, unknown> => ({
    testResults: [{ assertionResults: names.map((fullName) => ({ fullName, status: 'passed' })) }],
  });

  it('発火は「接頭辞 + 種別」を項目として名指ししていることを求める', () => {
    // 正しい形は欠けなし
    expect(
      missingFiringCases(reportOf([`${FIRING_TEST_PREFIX}cost 超過で発火`]), {
        kinds: ['cost'],
        firingPrefix: FIRING_TEST_PREFIX,
      }),
    ).toEqual([]);
    // 接頭辞が無いだけの名前では当たらない
    expect(
      missingFiringCases(reportOf(['cost の判定']), {
        kinds: ['cost'],
        firingPrefix: FIRING_TEST_PREFIX,
      }),
    ).toEqual(['cost']);
  });
});

describe('missingTamperCases', () => {
  // レポートを 1 本の名前から作る
  const reportOf = (names: string[]): Record<string, unknown> => ({
    testResults: [{ assertionResults: names.map((fullName) => ({ fullName, status: 'passed' })) }],
  });

  it('改ざん検知は接頭辞と壊れ方の**両方**を含むことを求める', () => {
    // 離れた 2 つの手がかりを両方持つ名前なら欠けなし
    expect(
      missingTamperCases(reportOf([`${TAMPER_TEST_PREFIX}書き換えた行は hash_mismatch で落ちる`]), {
        breaks: ['hash_mismatch'],
        tamperPrefix: TAMPER_TEST_PREFIX,
      }),
    ).toEqual([]);
    // 壊れ方の綴りだけで接頭辞が無い名前は、改ざん検知のテストとは言えない
    expect(
      missingTamperCases(reportOf(['hash_mismatch という値を作る']), {
        breaks: ['hash_mismatch'],
        tamperPrefix: TAMPER_TEST_PREFIX,
      }),
    ).toEqual(['hash_mismatch']);
  });

  it('接尾辞が一致する壊れ方を取り違えない (prev_hash_mismatch で hash_mismatch を満たさない)', () => {
    // **左側の境界を見ない版はここで通ってしまう** — `prev_hash_mismatch` の中の
    // `hash_mismatch` は直後が空白なので、右側だけの判定では境界を満たす (実測)。
    // そのとき `hash_mismatch` のテストが 1 件も無くてもゲートは緑のまま通る
    expect(
      missingTamperCases(
        reportOf([`${TAMPER_TEST_PREFIX}行を差し込むと prev_hash_mismatch で落ちる`]),
        { breaks: ['hash_mismatch'], tamperPrefix: TAMPER_TEST_PREFIX },
      ),
    ).toEqual(['hash_mismatch']);
  });
});

describe('列挙の正本の読み取り (source-enums)', () => {
  it('Prisma スキーマの enum を読める', () => {
    // **ドメイン側の TypeScript と一致することの担保は tests/domain-enums.test.ts が持つ**ので、
    // ここは「スキーマから読めた一覧がドメインと同じ」ことを見れば読み取りの正しさが分かる
    expect(readPrismaEnumMembers('test', 'RuleKind').sort()).toEqual(
      Object.values(RuleKind).sort(),
    );
  });

  it('TypeScript の as const の値を読める', () => {
    // 連鎖の壊れ方は DB に保存しないので schema には無く、ソースから読む
    expect(
      readTsConstValues('test', 'src/domain/audit/chain.ts', 'AuditChainBreak').sort(),
    ).toEqual(Object.values(AuditChainBreak).sort());
  });

  it('見つからなければ空配列 (呼び出し側が fail-closed で落とす)', () => {
    // 存在しない enum / 定数 / ファイル (どれも空配列。例外にしない)
    expect(readPrismaEnumMembers('test', 'NoSuchEnum')).toEqual([]);
    expect(readTsConstValues('test', 'src/domain/audit/chain.ts', 'NoSuchConst')).toEqual([]);
    // 読めないファイルは理由をエラー出力へ残す (握り潰さない)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(readTsConstValues('test', 'src/does-not-exist.ts', 'X')).toEqual([]);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe('firedRulesProblem', () => {
  it('発火が 0 件なら理由を返す (何も起きていない速さを通さない)', () => {
    // 1 件以上なら問題なし
    expect(firedRulesProblem(1)).toBeNull();
    // 0 件なら「停止まで」を測っていない
    expect(firedRulesProblem(0)).toContain('発火していません');
  });
});

describe('suspendedAgentsProblem', () => {
  it('停止が永続化されていなければ理由を返す', () => {
    // 1 件以上なら問題なし
    expect(suspendedAgentsProblem(1)).toBeNull();
    // 0 件なら発火だけを測っている
    expect(suspendedAgentsProblem(0)).toContain('停止していません');
  });
});

describe('auditRowsProblem', () => {
  it('監査ログが残っていなければ理由を返す (fail-open で抜けた分だけ速い数字)', () => {
    // 1 件以上なら問題なし
    expect(auditRowsProblem(1)).toBeNull();
    // 0 件なら記録の費用を含まない計測になっている
    expect(auditRowsProblem(0)).toContain('監査ログが残っていません');
  });
});

describe('guardrailStopProblem', () => {
  it('上限ちょうどは通し、1 超えたら理由を返す', () => {
    // 境界は上限ちょうどまで通す
    expect(guardrailStopProblem(GUARDRAIL_STOP_MAX_MS)).toBeNull();
    // 1 ミリ秒超えたら受け入れ基準を満たしていない
    expect(guardrailStopProblem(GUARDRAIL_STOP_MAX_MS + 1)).toContain(
      '発火から停止までが遅すぎます',
    );
  });
});

describe('runSteps', () => {
  it(
    'ステップが失敗したらその場で非 0 終了する (後続を実行しない)',
    () => {
      // 存在しない npm script を 1 つ実行させ、そのあとに到達しないことを見る
      const result = runInChild([
        `runSteps('テスト', [{ name: '失敗するステップ', args: ['run', '__agent_ops_missing_script__'] }]);`,
      ]);
      // 非 0 終了であること (process.exit を消すと 0 で終わり、続きまで到達する)
      expect(result.status, 'ゲートが失敗を素通りしている').not.toBe(0);
      // 後続へ進んでいないこと
      expect(result.stdout).not.toContain('REACHED_END');
    },
    testBudgetFor(1),
  );
});

describe('exitIfFailures', () => {
  it(
    '満たしていない基準があれば非 0 終了する (判定結果を捨てない)',
    () => {
      // 理由を 1 つ渡す
      const result = runInChild([`exitIfFailures('テスト', ['件数が足りません']);`]);
      // 非 0 終了で、続きへ進んでいないこと。**ここが実測で一番危なかった** —
      // この 1 行を消すと、失敗の理由を表示したうえで「ゲート緑」と出て exit 0 になった
      expect(result.status, 'ゲートが判定結果を捨てている').not.toBe(0);
      expect(result.stdout).not.toContain('REACHED_END');
    },
    testBudgetFor(1),
  );

  it(
    '基準を満たしていれば何もしない (正常時に落とさない)',
    () => {
      // 失敗が無いときは処理を続ける
      const result = runInChild([`exitIfFailures('テスト', []);`]);
      // 正常終了し、続きまで到達すること
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('REACHED_END');
    },
    testBudgetFor(1),
  );
});

describe('intFromEnv', () => {
  it('環境変数を名前で読んで整数にする', () => {
    // 変数名を 1 度しか書かせないための包み (名前 → 値の読み取りまでを共有モジュールが持つ)
    process.env.AGENT_OPS_BENCH_PROBE = '42';
    try {
      expect(intFromEnv('AGENT_OPS_BENCH_PROBE', 7, 0)).toBe(42);
    } finally {
      delete process.env.AGENT_OPS_BENCH_PROBE;
    }
  });

  it('未設定なら既定値を返す', () => {
    // 設定していない変数は既定値 (空文字は打ち間違いとして intFromEnvValue が落とす)
    delete process.env.AGENT_OPS_BENCH_PROBE;
    expect(intFromEnv('AGENT_OPS_BENCH_PROBE', 7, 0)).toBe(7);
  });
});

describe('intFromEnvValue', () => {
  it('未設定なら既定値を返す', () => {
    // 環境変数を置かない運用 (CI の既定) を壊さない
    expect(intFromEnvValue('BENCH_WARMUP', undefined, 200, 0)).toBe(200);
  });

  it.each([
    ['空文字', ''],
    ['空白だけ', ' '],
    ['改行だけ', '\n'],
    ['単位つき', '2s'],
    ['16 進', '0x10'],
    ['指数表記', '2e2'],
    ['前後に空白', ' 5 '],
    ['小数', '1.5'],
    ['負の数', '-1'],
  ])('10 進の整数として読めない値は落とす: %s', (_label, raw) => {
    // **空文字がいちばん危ない。** `Number('')` は 0 なので、最小値 0 の変数 (捨て玉の件数) では
    // そのまま受理され、捨て玉とそれに掛かるガード 2 本がまとめて黙って外れる (実測)。
    // CI の YAML で未設定の入力を渡すと空文字になるため、現実に踏む経路
    expect(() => intFromEnvValue('BENCH_WARMUP', raw, 200, 0)).toThrow();
  });

  it('最小値を下回る値は落とす', () => {
    // 0 を許さない変数 (秒数・接続数) で 0 を渡したとき
    expect(() => intFromEnvValue('BENCH_DURATION', '0', 10, 1)).toThrow();
  });

  it.each([
    ['0 (捨て玉を明示的に切る)', '0', 0, 0],
    ['1', '1', 0, 1],
    ['200', '200', 0, 200],
  ])('正当な値は受理する: %s', (_label, raw, minimum, expected) => {
    // 正当な値を弾かないこと (弾くと「捨て玉なしでも測れる」逃げ道が消える)
    expect(intFromEnvValue('BENCH_WARMUP', raw, 999, minimum)).toBe(expected);
  });
});

describe('warmupCountProblem', () => {
  it('件数が一致していれば問題なし', () => {
    // 指定どおりに止まった場合
    expect(warmupCountProblem(200, 200)).toBeNull();
  });

  it.each([
    ['多い (秒で回ってしまった)', 20109],
    ['少ない (途中で止まった)', 37],
  ])('件数が違えば理由を返す: %s', (_label, actual) => {
    // どちらでも本計測の数字は信用できないので落とす
    expect(warmupCountProblem(200, actual)).toContain('捨て玉が指定の件数で止まりませんでした');
  });
});

describe('warmupLatencyProblem', () => {
  it.each([
    ['上限より小さい', 117],
    ['上限ちょうど', WARMUP_MAX_MS],
  ])('上限以内なら問題なし: %s', (_label, maxMs) => {
    // 実測の初回コストは機械によって 88〜151ms なので、ここで落ちると日常的に赤くなる
    expect(warmupLatencyProblem(maxMs)).toBeNull();
  });

  it('上限を超えたら理由を返す', () => {
    // 桁が変わる悪化だけを捕まえる (266ms 程度は意図的に通す。理由は bench-criteria.mjs)
    expect(warmupLatencyProblem(WARMUP_MAX_MS + 1)).toContain('初回コストが大きすぎます');
  });
});

describe('non2xxProblem', () => {
  it('1 件も無ければ問題なし', () => {
    // 失敗が混ざっていなければ計測は成立している
    expect(non2xxProblem(0)).toBeNull();
  });

  it('1 件でもあれば理由を返す', () => {
    // 失敗した要求は速く返るので、混ざると追加遅延が実力より良く出る
    expect(non2xxProblem(1)).toContain('2xx 以外の応答がありました');
  });
});

describe('measuredRequestsProblem', () => {
  it.each([
    ['最小ちょうど', MIN_MEASURED_REQUESTS],
    ['最小より多い', MIN_MEASURED_REQUESTS + 1],
  ])('最小件数以上なら問題なし: %s', (_label, requests) => {
    // 計測として成立しているので null
    expect(measuredRequestsProblem(requests)).toBeNull();
  });

  it('最小件数を下回れば理由を返す', () => {
    // 1 件だけ成功して p97.5 が 0ms、のような結果を通さない
    expect(measuredRequestsProblem(MIN_MEASURED_REQUESTS - 1)).toContain('件しか流せていません');
  });
});

describe('addedLatencyProblem', () => {
  // **受け入れ基準そのものの判定なので、上下両側を固定する。** 結線の検査は「その名前を
  // 呼んでいるか」しか見ないので、比較式を緩めたり本体を空にしたりしても全件緑だった (実測)。
  // 片側だけだと「常に問題ありと返す」実装でも緑にできるので、通す側も見る
  it.each([
    ['上限より小さい', PROXY_ADDED_LATENCY_P95_MAX_MS - 1],
    ['上限ちょうど', PROXY_ADDED_LATENCY_P95_MAX_MS],
  ])('上限以内なら問題なし: %s', (_label, addedMs) => {
    // 基準を満たしているので null
    expect(addedLatencyProblem(addedMs)).toBeNull();
  });

  it('上限を 1 超えたら理由を返す', () => {
    // 基準を満たしていないので文言を返す (別の理由の文言と取り違えないよう中身も見る)
    expect(addedLatencyProblem(PROXY_ADDED_LATENCY_P95_MAX_MS + 1)).toContain(
      '追加遅延が大きすぎます',
    );
  });
});

describe('aggregateLatencyProblem', () => {
  it.each([
    ['上限より小さい', USAGE_AGGREGATE_MAX_MS - 1],
    ['上限ちょうど', USAGE_AGGREGATE_MAX_MS],
  ])('上限以内なら問題なし: %s', (_label, slowestMs) => {
    // 基準を満たしているので null
    expect(aggregateLatencyProblem(slowestMs)).toBeNull();
  });

  it('上限を 1 超えたら理由を返す', () => {
    // 基準を満たしていないので文言を返す
    expect(aggregateLatencyProblem(USAGE_AGGREGATE_MAX_MS + 1)).toContain('集計が遅すぎます');
  });
});

describe('benchCaseCountProblem', () => {
  it('受け入れ基準どおりの件数なら問題なし', () => {
    // 100 件ちょうど
    expect(benchCaseCountProblem(EVALUATION_BENCH_CASE_COUNT)).toBeNull();
  });

  it('件数が足りなければ理由を返す', () => {
    // **縮めて通す形がいちばん通しやすい** (少ない件数ほど一致率は上がりやすい)
    expect(benchCaseCountProblem(EVALUATION_BENCH_CASE_COUNT - 1)).toContain('採点したケース');
  });

  it('件数が多すぎても理由を返す', () => {
    // 基準は「100 件で」なので、多い側も測っているものが違う
    expect(benchCaseCountProblem(EVALUATION_BENCH_CASE_COUNT + 1)).toContain('採点したケース');
  });
});

describe('injectedVarianceProblem', () => {
  it('揺れが 1 件でも注入されていれば問題なし', () => {
    // 1 件でも違うスコアを返していれば、一致の判定が実際に動いている
    expect(injectedVarianceProblem(1)).toBeNull();
  });

  it('揺れが 0 件なら理由を返す', () => {
    // 決定論的なスタブでは一致率が必ず 100% になり、計測が何も検査しない
    expect(injectedVarianceProblem(0)).toContain('揺れが 1 件も注入されていません');
  });
});

describe('upstreamRequestsProblem', () => {
  it('上流を 1 回以上呼んでいれば問題なし', () => {
    // 経路を通っている
    expect(upstreamRequestsProblem(1)).toBeNull();
  });

  it('1 度も呼んでいなければ理由を返す', () => {
    // 経路を通らずに出した一致率は基準の証拠にならない
    expect(upstreamRequestsProblem(0)).toContain('上流を 1 度も呼んでいません');
  });
});

describe('disagreementProblem', () => {
  it.each([
    ['上限より少ない', maxDisagreedCases(EVALUATION_BENCH_CASE_COUNT) - 1],
    ['上限ちょうど', maxDisagreedCases(EVALUATION_BENCH_CASE_COUNT)],
  ])('上限以内なら問題なし: %s', (_label, disagreed) => {
    // 再現率が基準を満たしている
    expect(disagreementProblem(disagreed, EVALUATION_BENCH_CASE_COUNT)).toBeNull();
  });

  it('上限を 1 超えたら理由を返す', () => {
    // 100 件中 11 件が食い違えば再現率は 89% で基準 (90%) を下回る
    expect(
      disagreementProblem(
        maxDisagreedCases(EVALUATION_BENCH_CASE_COUNT) + 1,
        EVALUATION_BENCH_CASE_COUNT,
      ),
    ).toContain('再現率が低すぎます');
  });

  it('上限は件数から導く (件数が減れば許容も減る)', () => {
    // 10 件なら許容は 1 件。**上限を固定値で持っていたら、この差が出ない**
    expect(disagreementProblem(1, 10)).toBeNull();
    expect(disagreementProblem(2, 10)).toContain('再現率が低すぎます');
  });
});

// ベンチのラベルごとに「基準を満たす計測結果」と「各基準を 1 つだけ破る差分」を並べた表。
// **表は BENCH_CRITERIA を覆っていることまで検査する**ので、基準を足して挙動を書き忘れられない
const BENCH_PAYLOADS: Readonly<
  Record<string, { ok: Record<string, number>; breaks: readonly Record<string, number>[] }>
> = {
  'proxy-latency': {
    // すべての基準を満たす計測結果
    ok: {
      warmupRequests: 200,
      warmupDirectRequests: 200,
      warmupProxiedRequests: 200,
      warmupSlowestMs: WARMUP_MAX_MS,
      non2xx: 0,
      directRequests: MIN_MEASURED_REQUESTS,
      proxiedRequests: MIN_MEASURED_REQUESTS,
      addedMs: PROXY_ADDED_LATENCY_P95_MAX_MS,
    },
    // 基準ごとに 1 つだけ破る差分 (順番は BENCH_CRITERIA と同じ)。
    // **捨て玉の件数は「増える」向きで破る** — まとめ方が片側の増加を隠していた形を固定するため
    breaks: [
      { warmupDirectRequests: 2_500 },
      { warmupProxiedRequests: 37 },
      { warmupSlowestMs: WARMUP_MAX_MS + 1 },
      { non2xx: 1 },
      { directRequests: MIN_MEASURED_REQUESTS - 1 },
      { proxiedRequests: MIN_MEASURED_REQUESTS - 1 },
      { addedMs: PROXY_ADDED_LATENCY_P95_MAX_MS + 1 },
    ],
  },
  'usage-aggregate': {
    // 唯一の基準を満たす計測結果
    ok: { slowestMs: USAGE_AGGREGATE_MAX_MS },
    // その基準を破る差分
    breaks: [{ slowestMs: USAGE_AGGREGATE_MAX_MS + 1 }],
  },
  'evaluation-agreement': {
    // すべての基準を満たす計測結果 (ベンチが実際に出す値に合わせる)。
    // **食い違いを上限ちょうどにしない** — 件数を減らす破り方は上限も一緒に下げるので、
    // 上限ちょうどだと 2 つの基準が同時に破れて「1 つだけ破る」表の意味が崩れる
    ok: {
      cases: EVALUATION_BENCH_CASE_COUNT,
      flippedCases: EVALUATION_BENCH_FLIPPED_CASES,
      upstreamRequests: 1,
      disagreedCases: EVALUATION_BENCH_FLIPPED_CASES,
    },
    // 基準ごとに 1 つだけ破る差分 (順番は BENCH_CRITERIA と同じ)。
    // **件数は「減る」向きで破る** — 縮めて一致率を上げる形がいちばん通しやすいため
    breaks: [
      { cases: EVALUATION_BENCH_CASE_COUNT - 1 },
      { flippedCases: 0 },
      { upstreamRequests: 0 },
      { disagreedCases: maxDisagreedCases(EVALUATION_BENCH_CASE_COUNT) + 1 },
    ],
  },
  'guardrail-stop': {
    // すべての基準を満たす計測結果 (ベンチは 3 回測るので件数も 3)
    ok: { firedRules: 3, suspendedAgents: 3, auditRows: 3, elapsedMs: GUARDRAIL_STOP_MAX_MS },
    // 基準ごとに 1 つだけ破る差分 (順番は BENCH_CRITERIA と同じ)。
    // **件数は 0 で破る** — 「発火していない」「停止していない」「記録が無い」はどれも
    // 0 件として現れ、そのとき所要時間だけが基準を満たす (速い) 形になる
    breaks: [
      { firedRules: 0 },
      { suspendedAgents: 0 },
      { auditRows: 0 },
      { elapsedMs: GUARDRAIL_STOP_MAX_MS + 1 },
    ],
  },
  'demo-ready': {
    // すべての基準を満たす計測結果
    ok: {
      expectedSteps: DEMO_STEP_COUNT,
      stepsCompleted: DEMO_STEP_COUNT,
      stepsInOrder: DEMO_STEP_COUNT,
      agentsListed: 1,
      auditRows: 1,
      elapsedMs: DEMO_READY_MAX_MS,
    },
    // 基準ごとに 1 つだけ破る差分 (順番は BENCH_CRITERIA と同じ)。
    // **段は「減る」向きで破る** — 段を削って速く通す形がいちばん通しやすいため。
    // 2 つ目 (全部通ったか) は**実績だけ**を減らす (宣言を動かすと 1 つ目も同時に破れる)。
    // 3 つ目 (並び) は**一致した位置の数だけ**を減らす — 段の数は動かさない
    // (動かすと 1 つ目・2 つ目も同時に破れる)
    breaks: [
      { expectedSteps: DEMO_STEP_COUNT - 1 },
      { stepsCompleted: DEMO_STEP_COUNT - 1 },
      { stepsInOrder: DEMO_STEP_COUNT - 1 },
      { agentsListed: 0 },
      { auditRows: 0 },
      { elapsedMs: DEMO_READY_MAX_MS + 1 },
    ],
  },
  'concurrency-error-rate': {
    // すべての基準を満たす計測結果。**エラー率は上限ちょうどにしない** —
    // 基準は「< 1%」で等号を含まないので、ちょうどの値は満たさない側
    ok: {
      connections: CONCURRENCY_CONNECTIONS,
      requests: CONCURRENCY_MIN_REQUESTS,
      errorPercent: 0,
    },
    // 基準ごとに 1 つだけ破る差分 (順番は BENCH_CRITERIA と同じ)。
    // **同時接続は「減る」向き・エラー率は「境界ちょうど」で破る**
    breaks: [
      { connections: 1 },
      { requests: CONCURRENCY_MIN_REQUESTS - 1 },
      { errorPercent: CONCURRENCY_MAX_ERROR_PERCENT },
    ],
  },
};

describe('demoStepDefinitionProblem', () => {
  it('受け入れ基準どおりの段数なら問題なし', () => {
    // 正本の件数そのもの
    expect(demoStepDefinitionProblem(DEMO_STEP_COUNT)).toBeNull();
  });

  it('段を削った宣言を落とす', () => {
    // 1 段少ない (速く通すために段を削った形)
    expect(demoStepDefinitionProblem(DEMO_STEP_COUNT - 1)).toContain('段');
  });

  it('段を増やした宣言も落とす (基準と違うものを測っている)', () => {
    // 1 段多い
    expect(demoStepDefinitionProblem(DEMO_STEP_COUNT + 1)).not.toBeNull();
  });

  it('デモの筋の正本と受け入れ基準の件数が一致している', () => {
    // **これが無いと 2 つの正本が静かにずれる** — 段の中身は demo-flow.mjs、
    // 件数は step7-criteria.mjs が持つので、片方だけを動かす差分をここで落とす
    expect(DEMO_STEPS.length, 'DEMO_STEPS と DEMO_STEP_COUNT が食い違う').toBe(DEMO_STEP_COUNT);
    // 段の名前が重複していないこと (同じ段を 2 回数えて件数を満たす形を落とす)
    expect(new Set(DEMO_STEPS).size, 'デモの段の名前が重複している').toBe(DEMO_STEPS.length);
  });
});

describe('demoStepsCompletedProblem', () => {
  it('宣言した段を全部通っていれば問題なし', () => {
    // 宣言と実績が一致
    expect(demoStepsCompletedProblem(DEMO_STEP_COUNT, DEMO_STEP_COUNT)).toBeNull();
  });

  it('途中で終わった計測を落とす', () => {
    // 1 段足りない
    expect(demoStepsCompletedProblem(DEMO_STEP_COUNT, DEMO_STEP_COUNT - 1)).toContain('通って');
  });

  it('宣言より多く通っていても落とさない (宣言の正しさは別の判定が見る)', () => {
    // **役割を分けている**ので、ここは「足りないか」だけを見る
    expect(demoStepsCompletedProblem(DEMO_STEP_COUNT - 1, DEMO_STEP_COUNT)).toBeNull();
  });
});

describe('countStepsInOrder', () => {
  it('正本と同じ並びなら全段を数える', () => {
    // 正本そのもの
    expect(countStepsInOrder([...DEMO_STEPS])).toBe(DEMO_STEP_COUNT);
  });

  it('配列でなければ 0 と数える (判定が落ちる側へ倒す)', () => {
    // 項目が無い計測 (fail-closed)
    expect(countStepsInOrder(undefined as unknown as string[])).toBe(0);
  });
});

describe('demoStepOrderProblem', () => {
  it('全段が正本と同じ位置なら問題なし', () => {
    // 正本そのもの
    expect(countStepsInOrder([...DEMO_STEPS])).toBe(DEMO_STEP_COUNT);
    expect(demoStepOrderProblem(DEMO_STEP_COUNT, DEMO_STEP_COUNT)).toBeNull();
  });

  it('順を入れ替えた計測を落とす (件数は同じ)', () => {
    // 先頭 2 段を入れ替える (長さは変わらないので、件数を見る判定は落ちない)
    const swapped = [DEMO_STEPS[1], DEMO_STEPS[0], ...DEMO_STEPS.slice(2)];
    expect(swapped).toHaveLength(DEMO_STEP_COUNT);
    const inOrder = countStepsInOrder(swapped);
    expect(inOrder).toBeLessThan(DEMO_STEP_COUNT);
    expect(demoStepOrderProblem(DEMO_STEP_COUNT, inOrder)).toContain('並び');
  });

  it('同じラベルを 2 回積んだ計測を落とす (件数だけでは通る形)', () => {
    // 最後の段の代わりに最初の段をもう 1 回積む (`fetch` を消してラベルだけ残す形がこれ)
    const duplicated = [...DEMO_STEPS.slice(0, -1), DEMO_STEPS[0]];
    expect(duplicated).toHaveLength(DEMO_STEP_COUNT);
    expect(demoStepOrderProblem(DEMO_STEP_COUNT, countStepsInOrder(duplicated))).toContain('並び');
  });

  it('配列でなければ 0 と数えて落とす (計測が成立していない)', () => {
    // 項目が無い計測 (fail-closed)
    expect(countStepsInOrder(undefined as unknown as string[])).toBe(0);
    expect(demoStepOrderProblem(DEMO_STEP_COUNT, 0)).toContain('並び');
  });
});

describe('demoAgentsListedProblem', () => {
  it('1 件以上あれば問題なし', () => {
    // 登録したものが一覧に出た
    expect(demoAgentsListedProblem(1)).toBeNull();
  });

  it('0 件なら落とす (書いたものが読めていない)', () => {
    // 201 は返ったが一覧に出なかった形
    expect(demoAgentsListedProblem(0)).toContain('一覧');
  });
});

describe('demoAuditRowsProblem', () => {
  it('1 件以上あれば問題なし', () => {
    // 停止の操作が記録に残った
    expect(demoAuditRowsProblem(1)).toBeNull();
  });

  it('0 件なら落とす (読めただけでは記録が残る配備だと言えない)', () => {
    // 鍵を渡し忘れた配備・記録の書き込みが壊れた配備
    expect(demoAuditRowsProblem(0)).toContain('監査ログ');
  });
});

describe('demoReadyProblem', () => {
  it('上限以内なら問題なし', () => {
    // ちょうど上限 (等号は含む)
    expect(demoReadyProblem(DEMO_READY_MAX_MS)).toBeNull();
  });

  it('上限を超えたら落とす', () => {
    // 1 ミリ秒だけ超える
    expect(demoReadyProblem(DEMO_READY_MAX_MS + 1)).toContain(String(DEMO_READY_MAX_MS));
  });
});

describe('concurrencyConnectionsProblem', () => {
  it('受け入れ基準どおりの同時接続なら問題なし', () => {
    // 基準の値そのもの
    expect(concurrencyConnectionsProblem(CONCURRENCY_CONNECTIONS)).toBeNull();
  });

  it('同時接続を下げた計測を落とす', () => {
    // 1 接続 (同時実行の圧力が無いのでエラー率は 0% になる)
    expect(concurrencyConnectionsProblem(1)).toContain('同時接続');
  });
});

describe('concurrencyRequestsProblem', () => {
  it('最小件数以上なら問題なし', () => {
    // ちょうど下限
    expect(concurrencyRequestsProblem(CONCURRENCY_MIN_REQUESTS)).toBeNull();
  });

  it('件数が足りなければ落とす (分母が小さいと割合が緩くなる)', () => {
    // 1 件足りない
    expect(concurrencyRequestsProblem(CONCURRENCY_MIN_REQUESTS - 1)).toContain('しか流せて');
  });
});

describe('concurrencyErrorRateProblem', () => {
  it('上限未満なら問題なし', () => {
    // 0% は当然通る
    expect(concurrencyErrorRateProblem(0)).toBeNull();
  });

  it('**ちょうど上限は落とす** (基準の文は「< 1%」で等号を含まない)', () => {
    // 境界そのもの。**ゲート側の独立な比較は「≦ 上限」なので、ここが唯一の守り**
    expect(concurrencyErrorRateProblem(CONCURRENCY_MAX_ERROR_PERCENT)).toContain('エラー率');
  });

  it('上限を超えたら落とす', () => {
    // 倍のエラー率
    expect(concurrencyErrorRateProblem(CONCURRENCY_MAX_ERROR_PERCENT * 2)).not.toBeNull();
  });
});

describe('knownBugProblems', () => {
  // 問題なしの材料 (ここから 1 項目ずつ壊す)
  const clean = { docProblems: [], openIssues: [], markerHits: [], scannedFiles: 10 };

  it('文書の表が空でソースに印も無ければ問題なし', () => {
    // 2 つの手がかりがどちらも綺麗
    expect(knownBugProblems(clean)).toEqual([]);
  });

  it('文書に未解決の行があれば落とす', () => {
    // 表にデータ行が 1 本ある
    const failures = knownBugProblems({ ...clean, openIssues: ['| B-1 | 落ちる | 高 | 無し |'] });
    expect(failures.join(' ')).toContain('未解決のバグが 1 件');
  });

  it('ソースに印があれば落とす', () => {
    // 印が 1 件残っている
    const failures = knownBugProblems({ ...clean, markerHits: ['src/x.ts:3 印'] });
    expect(failures.join(' ')).toContain('src/x.ts:3');
  });

  it('文書の構造の問題はそのまま理由にする', () => {
    // 見出しが無い等
    expect(knownBugProblems({ ...clean, docProblems: ['見出しがありません'] })).toContain(
      '見出しがありません',
    );
  });

  it('走査が 1 ファイルも読めていなければ落とす (「印ゼロ＝緑」にしない)', () => {
    // 走査対象を縮める変更を落とす
    expect(knownBugProblems({ ...clean, scannedFiles: 0 }).join(' ')).toContain('1 ファイルも');
  });

  it('材料そのものが欠けていれば落とす (黙って飛ばさない)', () => {
    // 引数が無い = 呼び出し側が渡し忘れた
    expect(knownBugProblems().length).toBeGreaterThan(0);
  });
});

describe('readKnownIssues', () => {
  // 文書だけを置いた一時的なリポジトリを作る
  function withDoc(body: string): { openIssues: string[]; docProblems: string[] } {
    // 一時ディレクトリ
    const root = mkdtempSync(join(tmpdir(), 'agent-ops-known-issues-'));
    try {
      // 文書の置き場所を掘る
      const path = join(root, KNOWN_ISSUES_DOC);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
      // 読む
      return readKnownIssues(root);
    } finally {
      // 後始末
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('表が枠だけなら未解決 0 件', () => {
    // 見出し行と区切り行だけ
    const result = withDoc(`${KNOWN_ISSUES_HEADING}\n\n| ID | 内容 |\n| --- | --- |\n`);
    expect(result).toEqual({ openIssues: [], docProblems: [] });
  });

  it('枠より後ろの行を未解決として数える', () => {
    // データ行 1 本
    const result = withDoc(
      `${KNOWN_ISSUES_HEADING}\n\n| ID | 内容 |\n| --- | --- |\n| B-1 | 落ちる |\n`,
    );
    expect(result.openIssues).toEqual(['| B-1 | 落ちる |']);
  });

  it('次の見出しより後ろの表は数えない (節の外)', () => {
    // 別の節にある表（既知の制限の一覧）を未解決として数えてしまわないこと
    const result = withDoc(
      `${KNOWN_ISSUES_HEADING}\n\n| ID | 内容 |\n| --- | --- |\n\n## 既知の制限\n\n| 項目 | 内容 |\n| --- | --- |\n| 宿題 | 後で |\n`,
    );
    expect(result).toEqual({ openIssues: [], docProblems: [] });
  });

  it('見出しが無ければ落とす', () => {
    // 見出しを書き換えた形
    expect(withDoc('# 既知の問題\n').docProblems.join(' ')).toContain(KNOWN_ISSUES_HEADING);
  });

  it('表の枠が無ければ落とす (節を空にして黙らせる形を通さない)', () => {
    // 節はあるが表が無い
    expect(
      withDoc(`${KNOWN_ISSUES_HEADING}\n\n現在ありません。\n`).docProblems.join(' '),
    ).toContain('表の枠');
  });

  it('文書が無ければ落とす', () => {
    // 一時ディレクトリに何も置かない
    const root = mkdtempSync(join(tmpdir(), 'agent-ops-known-issues-'));
    try {
      expect(readKnownIssues(root).docProblems.join(' ')).toContain(KNOWN_ISSUES_DOC);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('commentPositions', () => {
  // 印の綴りは定数から組み立てる (このファイルのコメントに書くと検出網が自分自身を報告する)
  const marker = KNOWN_BUG_MARKERS[0];

  // 行末コメントの綴りと、それが有効な拡張子の例 (`#` は走査対象のどれでもコメントではない)
  it.each([
    ['//', 'src/x.ts'],
    ['--', 'prisma/x.sql'],
  ])('%s から行末までをコメントとして扱う (%s)', (opener, path) => {
    // その綴りで始まる行
    const line = `${opener} ${marker}`;
    const { flags } = commentPositions(line, false, lineCommentOpenersFor(path));
    // 印の位置がコメントの中であること
    expect(flags[line.indexOf(marker)]).toBe(true);
  });

  it('コードの中の値はコメントではない', () => {
    // 配列リテラル (コメントの開きがその手前に無い)
    const line = `const M = ['${marker}'];`;
    const { flags } = commentPositions(line, false);
    expect(flags[line.indexOf(marker)]).toBe(false);
  });

  it('囲みコメントは行をまたいで続く (途中の行に * が無くても)', () => {
    // 開きの行は閉じていない
    const opened = commentPositions('/* 説明', false);
    expect(opened.endsInBlock).toBe(true);
    // 次の行は行頭から全部コメント
    const line = `${marker} まだ直していない`;
    const { flags, endsInBlock } = commentPositions(line, opened.endsInBlock);
    expect(flags[line.indexOf(marker)]).toBe(true);
    expect(endsInBlock).toBe(true);
    // 閉じの行で状態が戻る
    expect(commentPositions(' */', true).endsInBlock).toBe(false);
  });

  it('閉じた後のコードはコメントではない', () => {
    // 同じ行で閉じて、その後ろに値を書く
    const line = `/* 説明 */ const M = '${marker}';`;
    const { flags, endsInBlock } = commentPositions(line, false);
    expect(flags[line.indexOf(marker)]).toBe(false);
    expect(endsInBlock).toBe(false);
  });
});

describe('lineCommentOpenersFor / 拡張子ごとの行末コメント', () => {
  it('.sql だけ -- が行末コメントになる', () => {
    // SQL は `--`、それ以外は `//` だけ
    expect(lineCommentOpenersFor('prisma/migrations/x/migration.sql')).toContain('--');
    expect(lineCommentOpenersFor('src/x.ts')).not.toContain('--');
  });

  it('TS の i-- で囲みコメントの追跡が切れない (一律に -- を当てた版の fail-open)', () => {
    // **実測で見つかった取り落ち** — `--` を全拡張子へ当てていた版は、この行で
    // 「ここから行末コメント」と誤読して続く `/*` を見落とし、囲みコメントの中の印が
    // まるごと素通りした
    const line = 'for (let i = n; i > 0; i--) total += i; /* note';
    const openers = lineCommentOpenersFor('src/x.ts');
    expect(commentPositions(line, false, openers).endsInBlock, '囲みコメントを開けていない').toBe(
      true,
    );
  });

  it('SQL では -- の後ろがコメントになる', () => {
    // マイグレーションのコメント
    const openers = lineCommentOpenersFor('prisma/x.sql');
    const { flags } = commentPositions('SELECT 1; -- 説明', false, openers);
    expect(flags[flags.length - 1]).toBe(true);
  });

  it('# はどの拡張子でもコメントにしない (走査対象にその文法が無い)', () => {
    // `.prisma` も `//` なので、`#` を持つとハッシュを含む文字列を誤ってコメント扱いにする
    for (const extension of SCANNED_EXTENSIONS) {
      expect(lineCommentOpenersFor(`x${extension}`)).not.toContain('#');
    }
  });
});

describe('findKnownBugMarkers', () => {
  // ソースを 1 本だけ置いた一時的なリポジトリを走査する
  function withSource(body: string, name = 'sample.ts'): { hits: string[]; scannedFiles: number } {
    // 一時ディレクトリ
    const root = mkdtempSync(join(tmpdir(), 'agent-ops-markers-'));
    try {
      // src/ に 1 本置く (入れ子でも置けるように掘る)
      mkdirSync(dirname(join(root, 'src', name)), { recursive: true });
      writeFileSync(join(root, 'src', name), body);
      // 走査する
      return findKnownBugMarkers(root);
    } finally {
      // 後始末
      rmSync(root, { recursive: true, force: true });
    }
  }

  // そのディレクトリ以下にある「走査対象の拡張子」のファイルを数える (走査の実装とは別に書く)
  function countScannedFiles(directory: string): number {
    // 見つかった数
    let total = 0;
    // 1 段ずつ掘る
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      // 下に潜る (node_modules は対象のディレクトリの下には無い)
      if (entry.isDirectory()) {
        total += countScannedFiles(join(directory, entry.name));
        continue;
      }
      // 拡張子が一致すれば数える
      if (SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) total += 1;
    }
    // 合計
    return total;
  }

  it.each([...KNOWN_BUG_MARKERS])('コメントに残った %s を拾う', (marker) => {
    // コメント行に印を書く (**綴りは定数から組み立てる** — このテストのコメントに
    // 印を直接書くと、この検出網が自分自身を報告する)
    const result = withSource(`// ${marker} いまここが壊れている\nexport const x = 1;\n`);
    expect(result.hits.join(' ')).toContain(marker);
    expect(result.hits.join(' ')).toContain('src/sample.ts:1');
  });

  it('SQL の -- コメントも拾う (マイグレーションは .sql)', () => {
    // `--` を見ていなかったときは、マイグレーションのコメントに書いた印が素通りした (実測)
    const result = withSource(
      `-- ${KNOWN_BUG_MARKERS[0]} この制約は壊れている\nSELECT 1;\n`,
      'migration.sql',
    );
    expect(result.hits.join(' ')).toContain('src/migration.sql:1');
  });

  it('囲みコメントの 2 行目以降も拾う (行頭の * に頼らない)', () => {
    // 整形の慣習に頼っていたときは、`*` の無い行が素通りした (実測)
    const result = withSource(`/* 説明\n${KNOWN_BUG_MARKERS[0]} まだ直していない\n*/\n`);
    expect(result.hits.join(' ')).toContain('src/sample.ts:2');
  });

  it('同じ行でコードの側に先に綴りが現れてもコメント中の印を拾う', () => {
    // **行内の最初の 1 回だけを見る形は取り落としになる** (実測: 直す前は 0 件だった)。
    // 1 行に「値としての綴り」と「本物の印」を両方書くのは自然な形なので、
    // 「惜しい書き方だけ拾えない」ではなく普通の fail-open
    const marker = KNOWN_BUG_MARKERS[0];
    const result = withSource(
      `export const label = ${JSON.stringify(marker)}; // ${marker} いまここが壊れている\n`,
    );
    expect(result.hits.join(' '), '行内の 2 回目以降を見ていない').toContain('src/sample.ts:1');
  });

  it('同じ行・同じ印は 1 件だけ数える (件数ではなく有無を見る判定なので)', () => {
    // コメントの中に同じ印を 2 回書く
    const marker = KNOWN_BUG_MARKERS[0];
    const result = withSource(`// ${marker} と ${marker} の 2 回\n`);
    // 1 行につき 1 件 (重複して積まない)
    expect(result.hits.filter((hit) => hit.includes(marker))).toHaveLength(1);
  });

  it('印の直後が英数字なら拾わない (伏字・プレースホルダで赤を出さない)', () => {
    // **直す手段が「コメントを書き換える」か「検出網を緩める」だけになる形を作らない** —
    // 実測で、伏字を書いたコメントが「未解決の欠陥の印」として報告された
    const marker = KNOWN_BUG_MARKERS[0];
    const result = withSource(`// 例: Authorization: Bearer sk-${marker}${marker} (値は伏せた)\n`);
    expect(result.hits, '伏字を印として報告している').toEqual([]);
  });

  it('印の直後が行末・空白・記号なら拾う (境界の判定で取り落とさない)', () => {
    // 行末・空白・コロンの 3 形（コロン付きの印は元から区切りを持つので、この境界で落ちない）
    const marker = KNOWN_BUG_MARKERS[0];
    for (const after of ['', ' いまここが壊れている', ': いまここが壊れている']) {
      expect(withSource(`// ${marker}${after}\n`).hits.join(' '), after).toContain(marker);
    }
  });

  it('コードの中の値は拾わない (印の一覧そのものを報告しない)', () => {
    // 配列リテラルとして書いた形 (コメントの始まりがその手前に無い)
    const result = withSource(`export const MARKERS = ${JSON.stringify(KNOWN_BUG_MARKERS)};\n`);
    expect(result.hits).toEqual([]);
  });

  it('走査したファイル数を返す (0 件なら判定側が落とす)', () => {
    // 1 本だけ置いたので 1
    expect(withSource('export const x = 1;\n').scannedFiles).toBe(1);
  });

  it.each(Object.keys(KNOWN_BUG_MARKER_EXCLUDED_DIRS))(
    '%s は走査しない (人が直せない生成物で赤を出さない)',
    (excluded) => {
      // 除外されたディレクトリの下に印を置く (除外は 'src/...' の形で宣言されている)
      const result = withSource(
        `// ${KNOWN_BUG_MARKERS[0]} 生成物のコメント\n`,
        `${excluded.replace(/^src\//, '')}/generated.ts`,
      );
      // 1 件も拾わず、走査もしていないこと
      expect(result).toEqual({ hits: [], scannedFiles: 0 });
    },
  );

  it('除外したディレクトリは gitignore 対象であること (古い登録を残さない)', () => {
    // **理由の妥当性はレビューで見るが、「生成物である」ことだけは機械で照合する** —
    // gitignore に無いディレクトリを除外していれば、それは人が直せる場所
    const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    // 1 件も無ければ照合が空振りしている (fail-closed)
    const excludedDirs = Object.entries(KNOWN_BUG_MARKER_EXCLUDED_DIRS);
    expect(excludedDirs.length, '除外の表が空').toBeGreaterThan(0);
    for (const [excluded, why] of excludedDirs) {
      expect(gitignore, `${excluded} が .gitignore に無い (生成物ではない)`).toContain(excluded);
      // 理由が空でないこと (「とりあえず黙らせる」使い方を塞ぐ)
      expect(why.trim().length, `${excluded} の除外に理由が無い`).toBeGreaterThan(0);
    }
  });

  it('対象のディレクトリが無ければ 0 件 (判定側が fail-closed で落とす)', () => {
    // 何も置かない
    const root = mkdtempSync(join(tmpdir(), 'agent-ops-markers-'));
    try {
      expect(findKnownBugMarkers(root)).toEqual({ hits: [], scannedFiles: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([...KNOWN_BUG_MARKER_DIRS])(
    '走査対象として宣言した %s は実在して中身を持つ (改名で黙って外れない)',
    (declared) => {
      // **宣言と実体がずれても誰も鳴らない形だった** — `filesUnder` は読み取りの失敗を `[]` に
      // 畳むので、`e2e/` を `tests/e2e/` へ移す (綴りを 1 文字変える) だけでその配下の印が
      // 走査対象から消える。他のディレクトリにファイルがあるかぎり `scannedFiles > 0` は
      // 成立し続けるので、判定側の「1 ファイルも読めていません」も鳴らない。
      // 痕跡は差分にもテスト件数にも出ないので、宣言の側を fail-closed で固定する
      const directory = join(ROOT, declared);
      expect(existsSync(directory), `${declared} が実在しない (改名・移動していないか)`).toBe(true);
      // 走査対象の拡張子を 1 つでも含むこと (空のディレクトリを宣言したままにしない)
      expect(
        countScannedFiles(directory),
        `${declared} に走査対象の拡張子のファイルが無い`,
      ).toBeGreaterThan(0);
    },
  );

  it('いまのリポジトリは既知バグ 0 (受け入れ基準④)', () => {
    // **実物を見る** — ゲートが読むのと同じ材料で、いま基準を満たしていることを固定する
    const issues = readKnownIssues();
    const markers = findKnownBugMarkers();
    expect(knownBugProblems({ ...issues, ...markers, markerHits: markers.hits })).toEqual([]);
  });
});

describe('evaluateStep7Report', () => {
  // Step6 までの材料 (1 件も pass していない空のレポート。前 Step の基準は必ず落ちる)。
  // **狙いは「引き継いでいるか」と「既知バグの判定が足されたか」の 2 点だけ**なので、
  // 前 Step の判定の中身は `evaluateStep6Report` の describe が固定している
  const step6 = {
    testStatus: 0,
    requiredPassedTests: 60,
    ...MATRIX,
    models: PRICED_MODELS,
    pricePrefix: PRICE_TEST_PREFIX,
    reasons: [],
    exclusionPrefix: EXCLUSION_TEST_PREFIX,
    kinds: [],
    firingPrefix: FIRING_TEST_PREFIX,
    breaks: [],
    tamperPrefix: TAMPER_TEST_PREFIX,
    e2eTestName: GUARDRAIL_E2E_TEST_NAME,
    reconcileTestName: RECONCILE_TEST_NAME,
    crossTenantDerivationTestName: '導出と表が一致する',
    crossTenantPrefix: '越境: ',
    crossTenantMinCount: 2,
    idempotencyPrefix: '冪等性: ',
    idempotencyMinCount: 2,
    coverageSummary: {
      total: {
        statements: { pct: 90 },
        branches: { pct: 90 },
        functions: { pct: 90 },
        lines: { pct: 90 },
      },
    },
    coverageMinPercent: 80,
    report: { numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, testResults: [] },
  };
  // 既知バグ 0 を満たす材料
  const cleanBugs = { docProblems: [], openIssues: [], markerHits: [], scannedFiles: 1 };

  it('Step6 までの基準を引き継ぐ (レポートが空なら落ちる)', () => {
    // 空のレポートなので Step1〜6 の判定がそのまま理由を積む
    const failures = evaluateStep7Report({ ...step6, knownBugs: cleanBugs });
    expect(failures.length, 'Step6 までの基準を引き継いでいない').toBeGreaterThan(0);
    // **既知バグの理由は混ざっていないこと** (材料は綺麗なので)
    expect(failures.join(' ')).not.toContain('未解決のバグ');
  });

  it('既知バグの材料が汚れていれば、その理由も積まれる', () => {
    // 文書に未解決の行がある材料
    const failures = evaluateStep7Report({
      ...step6,
      knownBugs: { ...cleanBugs, openIssues: ['| B-1 | 落ちる |'] },
    });
    expect(failures.join(' '), '既知バグ 0 の判定が掛かっていない').toContain('未解決のバグ');
  });
});

describe('benchOutputProblems', () => {
  // ベンチが実際に出す形 (npm 自身の行が前後に混ざる)
  const withLines = (json: string): string =>
    ['', '> agent-ops@0.1.0 bench:usage', '', json, ''].join('\n');
  // 基準を満たした 1 回ぶんの結果
  const okJson = JSON.stringify({
    bench: 'usage-aggregate',
    slowestMs: 13,
    limitMs: 1000,
    passed: true,
  });
  // 判定に渡す共通の引数 (**上限は正本から渡す** — ベンチの出力から読むと独立な検証にならない)
  const fields = { valueField: 'slowestMs', limitField: 'limitMs', limit: 1000 } as const;
  // 1 回ぶんの判定を短く書くための包み
  const problemsFor = (stdout: string, status = 0): string[] =>
    benchOutputProblems({ label: 'usage-aggregate', status, stdout, ...fields });

  it('基準を満たした出力なら問題なし', () => {
    // 終了コード 0・ラベル一致・passed: true・実測値が上限以内・上限が正本と一致
    expect(problemsFor(withLines(okJson))).toEqual([]);
  });

  it('終了コードが 0 でなければ落とす', () => {
    // ベンチ自身が理由を出しているので、ここでは事実だけを残す
    expect(problemsFor(withLines(okJson), 1)).toHaveLength(1);
  });

  it('結果の JSON が無ければ落とす', () => {
    // **これがゲートの要点** — 「何も出さずに exit 0」を緑にしない (fail-closed)
    expect(problemsFor('')).toEqual(['ベンチ usage-aggregate が結果の JSON を出していません']);
  });

  it('別のベンチの結果しか無ければ落とす', () => {
    // ラベルの取り違え (片方のベンチを 2 回流す形) を落とす
    const other = JSON.stringify({
      bench: 'proxy-latency',
      slowestMs: 13,
      limitMs: 1000,
      passed: true,
    });
    expect(problemsFor(withLines(other))).toContain(
      'ベンチ usage-aggregate の結果のラベルが "proxy-latency" です',
    );
  });

  it('同じラベルの結果が 2 本あれば落とす', () => {
    // **「読めた最後の行を採る」形だと、本物の失敗行のあとに嘘の合格行を足すだけで後勝ちした** (実測)
    const lying = JSON.stringify({
      bench: 'usage-aggregate',
      slowestMs: 9999,
      limitMs: 1000,
      passed: false,
    });
    expect(problemsFor([lying, okJson].join('\n'))).toEqual([
      'ベンチ usage-aggregate の結果の JSON が 2 本あります',
    ]);
  });

  it('passed が true でなければ落とす', () => {
    // ベンチ側の判定をそのまま尊重する
    expect(problemsFor(withLines(okJson.replace('"passed":true', '"passed":false')))).toContain(
      'ベンチ usage-aggregate が受け入れ基準を満たしていません',
    );
  });

  it('passed が true でも実測値が上限を超えていれば落とす', () => {
    // **`passed` の写しにしない** — passed だけを見ると「true を出すだけ」の変異が素通りする
    const lying = JSON.stringify({
      bench: 'usage-aggregate',
      slowestMs: 1001,
      limitMs: 1000,
      passed: true,
    });
    expect(problemsFor(withLines(lying))).toContain(
      'ベンチ usage-aggregate の slowestMs が上限を超えています (1001 > 1000)',
    );
  });

  it('出力の上限が正本と違えば落とす', () => {
    // **上限をベンチの出力から読むと比較の両辺が同じ出力に由来する** — 実測で、ベンチ側の
    // limitMs を 100 倍にするだけで全件緑のまま基準が 100 倍に緩んだ
    const inflated = JSON.stringify({
      bench: 'usage-aggregate',
      slowestMs: 13,
      limitMs: 100_000,
      passed: true,
    });
    expect(problemsFor(withLines(inflated))).toContain(
      'ベンチ usage-aggregate の limitMs が受け入れ基準と違います (100000 ≠ 1000)',
    );
  });

  it('実測値が数値でなければ落とす', () => {
    // 項目を消すだけで比較を飛ばせないようにする (fail-closed)
    const missing = JSON.stringify({ bench: 'usage-aggregate', limitMs: 1000, passed: true });
    expect(problemsFor(withLines(missing))).toContain(
      'ベンチ usage-aggregate の結果に数値の slowestMs がありません',
    );
  });

  it('比較の材料が指定されていなければ落とす', () => {
    // 呼び出し側で 1 つ省くだけで比較が無音で消えないようにする
    expect(
      benchOutputProblems({ label: 'usage-aggregate', status: 0, stdout: withLines(okJson) }),
    ).toContain('ベンチ usage-aggregate の検査に実測値・上限の指定がありません');
  });

  it('無関係な JSON の行が混ざっていても正しい結果を読む', () => {
    // 進捗の出力に `{` で始まる行が混ざっても、ラベルで選ぶので誤って赤にならない
    expect(problemsFor(['{ これは JSON ではない', '{}', okJson].join('\n'))).toEqual([]);
  });
});

describe('benchLabels', () => {
  it('基準を持つベンチのラベルをすべて返す', () => {
    // 表のキーをそのまま列挙する (検査はこれと突き合わせて網羅を確かめる)
    expect(benchLabels().sort()).toEqual([
      'concurrency-error-rate',
      'demo-ready',
      'evaluation-agreement',
      'guardrail-stop',
      'proxy-latency',
      'usage-aggregate',
    ]);
  });
});

describe('benchCriteriaJudges', () => {
  it('表で実際に使われている判定を同一性で返す', () => {
    // 使われている判定
    const used = benchCriteriaJudges();
    // 集計ベンチの唯一の基準はこの判定 (名前ではなく関数そのもので持つ)
    expect(used.has(aggregateLatencyProblem)).toBe(true);
    // プロキシ側の基準も含まれる
    expect(used.has(addedLatencyProblem)).toBe(true);
  });

  it('表に無い関数は含まない', () => {
    // 判定ではないものを「使われている」と数えない (fail-closed の突き合わせが空振りしないように)
    expect(benchCriteriaJudges().has(intFromEnvValue)).toBe(false);
  });
});

describe('benchCriteriaFields', () => {
  it('基準ごとの読み取り項目を返す', () => {
    // 集計ベンチは slowestMs 1 つだけを読む
    expect(benchCriteriaFields('usage-aggregate')).toEqual([{ fields: ['slowestMs'] }]);
    // **プロキシ側も期待値を書く** — 自己整合 (表と payload を同時に直す) だけだと、
    // 基準を無害な項目へ差し替えても整合したまま通る
    expect(benchCriteriaFields('proxy-latency')).toEqual([
      { fields: ['warmupRequests', 'warmupDirectRequests'] },
      { fields: ['warmupRequests', 'warmupProxiedRequests'] },
      { fields: ['warmupSlowestMs'] },
      { fields: ['non2xx'] },
      { fields: ['directRequests'] },
      { fields: ['proxiedRequests'] },
      { fields: ['addedMs'] },
    ]);
  });

  it('未知のラベルは落とす', () => {
    // 表に無いラベルは設定ミスなので黙って空を返さない
    expect(() => benchCriteriaFields('nope')).toThrow('未知のベンチです');
  });
});

describe('judgeBenchPayload', () => {
  // **表から導いて全基準を上下両側で固定する。** 手書きの一覧だと、基準を足したときに
  // 挙動の検査だけが取り残される (実測: 判定の本体を `return null` にしても全件緑だった)
  it.each(Object.keys(BENCH_PAYLOADS))('基準を満たす計測結果は問題なし: %s', (label) => {
    // すべて満たしているので空配列
    expect(judgeBenchPayload(label, BENCH_PAYLOADS[label].ok)).toEqual([]);
  });

  it.each(
    Object.entries(BENCH_PAYLOADS).flatMap(([label, entry]) =>
      entry.breaks.map((patch, index) => [label, index, patch] as const),
    ),
  )('基準を 1 つ破れば問題を返す: %s #%i', (label, _index, patch) => {
    // 満たす結果に、その基準だけを破る差分を当てる
    expect(judgeBenchPayload(label, { ...BENCH_PAYLOADS[label].ok, ...patch }).length).toBe(1);
  });

  it.each(Object.keys(BENCH_PAYLOADS))('表が基準を過不足なく覆っている: %s', (label) => {
    // 破る差分の数が基準の数と一致すること (足した基準の書き忘れを落とす)
    expect(BENCH_PAYLOADS[label].breaks.length).toBe(benchCriteriaFields(label).length);
    // それぞれの差分が、その基準の読み取り項目だけを触っていること (別の基準を破って数を合わせない)
    benchCriteriaFields(label).forEach(({ fields }, index) => {
      // 差分の項目がその基準の読み取り項目に含まれること
      expect(fields).toEqual(
        expect.arrayContaining(Object.keys(BENCH_PAYLOADS[label].breaks[index])),
      );
    });
  });

  it('計測結果に数値の項目が無ければ落とす', () => {
    // 項目名の打ち間違いで基準が黙って飛ばされるのを防ぐ (fail-closed)
    expect(() => judgeBenchPayload('usage-aggregate', {})).toThrow('数値の slowestMs がありません');
  });
});

// 標準出力/エラー出力を黙らせて覗く (呼び出し 2 か所で型をそろえるため関数にする)
function spyOnConsole(method: 'log' | 'error') {
  // その出力を呼び出しごと記録し、実際には出さない
  return vi.spyOn(console, method).mockImplementation(() => undefined);
}

// runBench を 1 回動かし、出力・エラー出力・終了コードを取る。
// **process.exitCode は必ず元へ戻す** — 戻さないと vitest 自身が非 0 で終わる
async function captureBenchRun(
  label: string,
  measure: () => Promise<Record<string, unknown>>,
): Promise<{ printed: string[]; errors: string[]; exitCode: typeof process.exitCode }> {
  // 走らせる前の終了コード
  const before = process.exitCode;
  // 覗きの設置も try の中で行う (2 本目の設置が失敗したとき 1 本目を戻せるように)
  let printed: ReturnType<typeof spyOnConsole> | undefined;
  let errors: ReturnType<typeof spyOnConsole> | undefined;
  try {
    // 標準出力・エラー出力を覗く
    printed = spyOnConsole('log');
    errors = spyOnConsole('error');
    // 実行する (throw せず process.exitCode で伝える契約)
    await runBench(label, measure);
    // 取れたものを返す
    return {
      printed: printed.mock.calls.map((call) => String(call[0])),
      errors: errors.mock.calls.map((call) => call.map(String).join(' ')),
      exitCode: process.exitCode,
    };
  } finally {
    // 覗きを戻し、終了コードも元へ戻す
    printed?.mockRestore();
    errors?.mockRestore();
    process.exitCode = before;
  }
}

describe('runBench', () => {
  it.each(Object.keys(BENCH_PAYLOADS))(
    '基準を満たせば結果を出して終了コードを触らない: %s',
    async (label) => {
      // 満たす計測結果を返す
      const run = await captureBenchRun(label, async () => BENCH_PAYLOADS[label].ok);
      // 出した JSON に bench と passed: true が入る (比較式の写しを作らないための要点)
      expect(JSON.parse(run.printed[0])).toEqual({
        bench: label,
        ...BENCH_PAYLOADS[label].ok,
        passed: true,
      });
      // 成功なので終了コードは触らない
      expect(run.exitCode).toBeUndefined();
    },
  );

  it.each(
    Object.entries(BENCH_PAYLOADS).flatMap(([label, entry]) =>
      entry.breaks.map((patch, index) => [label, index, patch] as const),
    ),
  )('基準を 1 つでも破れば passed: false と非 0 終了: %s #%i', async (label, _index, patch) => {
    // その基準だけを破る計測結果を返す
    const run = await captureBenchRun(label, async () => ({
      ...BENCH_PAYLOADS[label].ok,
      ...patch,
    }));
    // **結果は出す** (何が起きたか読めないまま落とさない)
    expect(JSON.parse(run.printed[0]).passed).toBe(false);
    // 理由も出す
    expect(run.errors.join('\n')).toContain(`[bench:${label}]`);
    // そのうえで非 0 で終わる (ゲートは終了コードしか見ない)
    expect(run.exitCode).toBe(1);
  });

  it('計測結果が名乗るラベルと passed は上書きする', async () => {
    // **payload 側が同じ項目を持っていても、ゲートが読む値はこちらが決める**
    const run = await captureBenchRun('usage-aggregate', async () => ({
      ...BENCH_PAYLOADS['usage-aggregate'].ok,
      bench: 'proxy-latency',
      passed: false,
    }));
    // 名乗るラベルは呼び出し時のもの、passed は判定から導いたもの
    expect(JSON.parse(run.printed[0])).toMatchObject({ bench: 'usage-aggregate', passed: true });
  });

  it('計測そのものが失敗したら理由を出して非 0 終了', async () => {
    // 計測中の例外も「非 0 で終わる」へ寄せる
    const run = await captureBenchRun('usage-aggregate', async () => {
      throw new Error('集計結果が空です');
    });
    // 理由を出す
    expect(run.errors.join('\n')).toContain('集計結果が空です');
    // 非 0 で終わる
    expect(run.exitCode).toBe(1);
    // 結果の JSON は出さない (測れていないので載せる値が無い)
    expect(run.printed).toEqual([]);
  });

  it('未知のラベルは非 0 終了', async () => {
    // ラベルの打ち間違いで基準が 1 つも掛からないまま緑になるのを防ぐ
    const run = await captureBenchRun('nope', async () => ({ slowestMs: 1 }));
    expect(run.errors.join('\n')).toContain('未知のベンチです');
    expect(run.exitCode).toBe(1);
  });
});

describe('判定の結線', () => {
  // **ゲートは全部 `exitIfFailures` を呼ぶ。** 呼ばないものは理由付きでここへ登録する。
  // 以前は「gate-report.mjs を読んでいるゲートだけ」を対象にしていたが、
  // **判定をゲート本体へインライン化して exitIfFailures も捨てる**差分が対象から外れて全件緑だった
  // (実測。しかも `includes` の文字列一致なので、コメントに書いてあるだけでも対象に残っていた)
  // 除外したゲートに許す呼び出し (検証コマンドを順に流して結果を表示するだけ)。
  // 判定を書き写すとレポートの読み取り等でこの外の呼び出しが必ず増えるので、そこで落ちる
  const EXCLUDED_GATE_ALLOWED_CALLS = ['runSteps', 'banner'];

  const GATE_EXIT_EXCLUSIONS: Readonly<Record<string, string>> = {
    'gate-step0.mjs': '判定を持たず検証コマンドを順に流すだけ。失敗は runSteps がその場で落とす',
  };

  // そのゲートが本来使うべき判定の名前 (`gate-step2.mjs` → `evaluateStep2Report`)。
  // **判定を「どれか 1 つ」で済ませない** — `gate-step2.mjs` が `evaluateStep1Report` を呼ぶよう
  // 差し替えると、Step2 固有の基準 (料金表の全モデル分のテストが存在し pass すること) が
  // 丸ごと消えるのに、全件緑・件数も不変で通った (実測)。ロードマップのゲート運用ルール 2
  // 「後 Step は前 Step の基準を引き継いだうえで自分の基準を足す」の後半が消える形
  const ownJudgementOf = (gateName: string): string | null => {
    // ファイル名から Step 番号を取り出す
    const step = /^gate-step(\d+)\.mjs$/.exec(gateName)?.[1];
    // 取り出せなければ対応する判定は決められない
    return step === undefined ? null : `evaluateStep${step}Report`;
  };

  // 判定 (gate-report.mjs が公開する関数) の名前。**一覧を手書きしない** — 足した判定が黙って外れる
  const judgementNames = async (): Promise<string[]> => {
    // モジュールの実体を読む
    const report = await importSharedModule('gate-report.mjs');
    // 関数として公開されているものが判定 (定数は除く)
    return Object.keys(report).filter((key) => typeof report[key] === 'function');
  };

  // 判定を持つ共有モジュールのうち、**ベンチが必ず通さなければならない**もの。
  // ベンチは全テーブルを TRUNCATE するので、接続先が専用 DB かの判定は 1 本も飛ばせない
  const REQUIRED_BENCH_MODULE = 'contract-database.mjs';
  // ベンチスクリプトの一覧 (名前の付け方が手がかり)
  const benchScriptNames = (): string[] =>
    readdirSync(SCRIPTS_DIR).filter((name) => /^bench-.*\.ts$/.test(name));

  it('ゲートスクリプトを 1 本以上見つけられる', () => {
    // 0 本なら走査が壊れている (fail-closed)
    expect(gateScriptNames().length, 'ゲートスクリプトが 1 本も無い').toBeGreaterThan(0);
  });

  it('走査で見つかるゲート/ベンチは package.json が実際に起動するものと一致する', () => {
    // **名前の規約だけで導くと、改名しただけで全検査から静かに消える。** 実測で
    // `bench-usage-aggregate.ts` を `usage-aggregate-bench.ts` へ改名し package.json を
    // 追随させると、専用 DB のガードごと消しても 713 件すべて緑・件数も不変で通った。
    // **導出とは独立な手がかり**として、npm スクリプトが実際に起動するファイル名と突き合わせる
    const scripts = (
      JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    // `<実行コマンド> scripts/<ファイル名>` の形からファイル名を取り出す
    const launchedBy = (prefix: string): string[] =>
      Object.entries(scripts)
        .filter(([name]) => name.startsWith(prefix))
        .map(([, command]) => /(?:^|\s)scripts\/([\w.-]+)(?:\s|$)/.exec(command)?.[1])
        .filter((name): name is string => name !== undefined)
        .sort();
    // 起動されるゲートが 0 本なら読み取りが壊れている (fail-closed)
    expect(launchedBy('gate:').length, 'package.json が起動するゲートが 0 本').toBeGreaterThan(0);
    // 起動されるベンチが 0 本でも同じ
    expect(launchedBy('bench:').length, 'package.json が起動するベンチが 0 本').toBeGreaterThan(0);
    // 走査で見つかる一覧と一致すること (片方にしか無いものがあれば落ちる)
    expect(gateScriptNames().sort(), 'ゲートの一覧が package.json と食い違う').toEqual(
      launchedBy('gate:'),
    );
    expect(benchScriptNames().sort(), 'ベンチの一覧が package.json と食い違う').toEqual(
      launchedBy('bench:'),
    );
  });

  it('除外は実在するゲートにだけ付いている', () => {
    for (const [name, reason] of Object.entries(GATE_EXIT_EXCLUSIONS)) {
      // 消えたゲートの除外が残り続けないように
      expect(gateScriptNames(), `${name} は実在しない`).toContain(name);
      // 理由が空の除外は「とりあえず黙らせる」使い方になる
      expect(reason.trim().length, `${name} の除外理由が空`).toBeGreaterThan(0);
    }
  });

  it('判定を持つ Step のゲートは除外できない', async () => {
    // **除外表に 1 行足せば、判定を「書き写す」のではなく「丸ごと消す」ことができた** (実測で
    // 717 件緑・赤ゼロ。痕跡は件数が 1 減るだけ)。判定を消せば「判定を持たない」という除外理由も
    // 構造の検査も文字どおり成り立ってしまうので、**その Step の判定が存在するかどうか**で切る
    const judgements = await judgementNames();
    // 1 つも無ければ導出が壊れている (fail-closed)
    expect(judgements.length, '判定を 1 つも読めない').toBeGreaterThan(0);
    for (const name of Object.keys(GATE_EXIT_EXCLUSIONS)) {
      // そのゲートが本来使うべき判定
      const own = ownJudgementOf(name);
      // それが gate-report.mjs にあるなら、判定を持つ Step なので除外できない
      expect(
        own !== null && judgements.includes(own),
        `${name} には ${own ?? '対応する'} 判定があるので除外できない`,
      ).toBe(false);
    }
  });

  it('除外したゲートは判定を 1 つも持たない (理由が構造としても成り立っている)', async () => {
    // **理由の文字列だけでは裏打ちにならない。** もっともらしい理由を 1 行足すだけで、
    // そのゲートの結線の検査が黙って消える (実測: `gate-step2.mjs` を除外して
    // `exitIfFailures` の呼び出しごと消すと 698 件すべて緑だった)。
    // 除外してよいのは「判定を持たない」ゲートだけなので、そこを構造で確かめる
    //
    // 判定の名前は**モジュールの export から導く** (一覧を手書きすると、足した判定が黙って外れる)
    const judgements = await judgementNames();
    // 1 つも無ければ導出が壊れている (fail-closed)
    expect(judgements.length, '判定を 1 つも読めない').toBeGreaterThan(0);
    for (const name of Object.keys(GATE_EXIT_EXCLUSIONS)) {
      // **取り込みの有無で見るのが主**。`callsFunction` は「捉えられない形は false」なので、
      // **false を期待するこの検査では偽陰性が緑側に出る** — 実測で、判定を別名で取り込み
      // (`import { evaluateStep2Report as evalReport }`)、`exitIfFailures` の呼び出しを消し、
      // 除外表へもっともらしい理由を 1 行足すと **赤ゼロ**で通った (痕跡は件数が 1 減るだけ)。
      // 取り込みは別名でも同じモジュール名として現れるので、この向きなら偽陰性が赤側に出る
      expect(
        importedSharedNames(join(SCRIPTS_DIR, name)).has('gate-report.mjs'),
        `${name} は判定のモジュールを取り込んでいるので除外できない`,
      ).toBe(false);
      for (const judgement of judgements) {
        // 取り込まずに判定名を呼ぶ形 (同名の自前関数など) も一応見る (補助)
        expect(
          callsFunction(join(SCRIPTS_DIR, name), judgement),
          `${name} は ${judgement} で判定しているので除外できない`,
        ).toBe(false);
      }
      // **判定を書き写せば除外の理由は成り立ってしまう。** 実測で、gate-report.mjs の
      // 取り込みをやめて判定を数行インライン化し、除外表へ 1 行足すと**赤ゼロ**で通った
      // (痕跡は件数が 1 減るだけ)。除外できるのは「検証コマンドを順に流すだけ」のゲートなので、
      // **構造そのもの**を要求する: 取り込みは共有モジュールだけ、呼び出しは実行ヘルパーだけ。
      // 取り込みは動的 `import()` / `require()` まで見て、**絶対パスで解決**して判定する
      // (静的 import と文字列一致だけを見ていたときは、`await import('node:fs')` と
      // メンバ式呼び出しでインライン化したゲートが素通りした。実測)
      expect(
        foreignModuleSpecifiers(join(SCRIPTS_DIR, name)),
        `${name} は共有モジュール以外を取り込んでいるので除外できない`,
      ).toEqual([]);
      for (const called of reachableCallNames(join(SCRIPTS_DIR, name))) {
        expect(
          EXCLUDED_GATE_ALLOWED_CALLS.includes(called),
          `${name} は ${called} を呼んでいるので「順に流すだけ」ではない`,
        ).toBe(true);
      }
    }
  });

  it.each(gateScriptNames().filter((name) => GATE_EXIT_EXCLUSIONS[name] === undefined))(
    '%s は判定結果で落とす (exitIfFailures を呼ぶ)',
    async (name) => {
      // **呼び出しと import をまとめて消す変異は eslint にも映らない** (未使用が残らないため)。
      // 実測で、その 3 点セットを当てると lint も tsc も vitest も全件緑のまま
      // ゲートの最後の 1 歩 (非 0 終了) が消えた。**構文木で見る** — 文字列一致だと、
      // 呼び出しを消してコメントに残すだけで満たされる (実測で全件緑・件数も不変)
      // 判定の名前 (この表が渡してよい値の唯一の源)
      const judgements = await judgementNames();
      // 1 つも無ければ導出が壊れている (fail-closed)
      expect(judgements.length, '判定を 1 つも読めない').toBeGreaterThan(0);
      // **綴りの一致だけでは、実測で 4 通りの迂回があった** (いずれも全件緑・lint も 0):
      //   (a) `const failures = rawFailures.filter(() => false);` と **1 文はさむ**
      //   (b) 呼び出しを `if (process.env.GATE_STRICT === '1') …` と**条件で囲む**
      //   (c) import をやめ、**同名のローカル no-op** をその場で宣言する
      //   (d) 一度も呼ばれない関数の中へ移す
      // そこで 4 つまとめて要求する: **トップレベルの式文**として (b)(d)、
      // **共有モジュールから取り込んだ名前**で (c)、**判定の呼び出しそのもの**を渡して (a)。
      // 渡してよい判定は**その Step のもの 1 つに絞る** — 判定が存在しない Step
      // (まだ書かれていない) のときだけ、全判定のどれかを許す (新しい Step の判定を
      // 足し忘れたら自動でこの緩い側へ落ちるので、検査が行き止まりにならない)
      const own = ownJudgementOf(name);
      // その Step の判定が実在するなら、それだけを許す
      const allowed = own !== null && judgements.includes(own) ? [own] : judgements;
      expect(
        callsFunction(join(SCRIPTS_DIR, name), 'exitIfFailures', {
          atTopLevel: true,
          importedFrom: 'run-npm-steps.mjs',
          argument: { index: 1, callOf: allowed, importedFrom: 'gate-report.mjs' },
        }),
        `${name} が ${allowed.join(' / ')} の結果そのもので exitIfFailures を呼んでいない`,
      ).toBe(true);
    },
  );

  it('ベンチは scripts/lib から取り込んだ判定を全部呼ぶ', async () => {
    // ベンチが 1 本も無ければ導出が壊れている (fail-closed)
    const benches = benchScriptNames();
    expect(benches.length, 'ベンチが 1 本も無い').toBeGreaterThan(0);
    // 実際に検査した判定の数 (0 件のまま緑にしない)
    let checked = 0;
    for (const bench of benches) {
      // **取り込みは構文木から導く** — 文字列一致だと、コメントに綴りがあるだけで対象に数え、
      // 逆に対象から外す変異には気付けない
      for (const [moduleName, names] of importedSharedNames(join(SCRIPTS_DIR, bench))) {
        // そのモジュールの実体 (関数かどうかを見るため)
        const shared = await importSharedModule(moduleName);
        for (const { exported, local } of names) {
          // 定数の取り込みは対象外 (呼ぶものではない)
          if (typeof shared[exported] !== 'function') continue;
          // 1 件検査する
          checked += 1;
          // 取り込んだまま呼ばない形 (判定を素通りさせる変異) を落とす
          expect(
            callsFunction(join(SCRIPTS_DIR, bench), local),
            `${bench} が ${moduleName} の ${exported} を取り込んだまま呼んでいない`,
          ).toBe(true);
        }
      }
    }
    // 1 件も見ていなければ導出が壊れている (fail-closed)
    expect(checked, '判定を 1 つも検査していない').toBeGreaterThan(0);
  });

  it('共有モジュールの判定はすべて挙動を固定している', async () => {
    // **結線の検査だけでは中身が空でも緑になる。** 実測で `requireAddedLatencyWithinLimit` の
    // `throw` 行を 1 行消すと、lint も tsc も全 722 件も緑のまま Step2 の追加遅延基準が
    // 無効になった (結線の検査は「その名前を呼んでいるか」しか見ないため)。
    // **一覧は手書きせず export から導く** — 次に判定を足した人が同じ穴を再生産しないように
    const described = describedNamesWithTests(fileURLToPath(import.meta.url));
    // 1 つも読めなければ走査が壊れている (fail-closed)
    expect(described.length, 'describe を 1 つも読めない').toBeGreaterThan(0);
    // 判定を持つ共有モジュール (この 2 つが受け入れ基準の判定を持つ)
    for (const moduleName of ['bench-criteria.mjs', 'gate-report.mjs']) {
      // そのモジュールの実体
      const shared = await importSharedModule(moduleName);
      // 関数として公開されているものが判定
      const judgements = Object.keys(shared).filter((key) => typeof shared[key] === 'function');
      // 1 つも無ければ導出が壊れている (fail-closed)
      expect(judgements.length, `${moduleName} の判定を 1 つも読めない`).toBeGreaterThan(0);
      for (const name of judgements) {
        // このファイルに同名の describe があり、中に it を持つこと。
        // **文字列の部分一致で見ない** — コメントに綴りを残すだけで満たせてしまい、
        // 判定の本体を `return null` にしても赤が 1 件も出なかった (実測)
        expect(
          described,
          `${name} の挙動を固定する describe (中身つき) がこのファイルに無い`,
        ).toContain(name);
      }
    }
  });

  // ベンチのファイル名と、そのベンチが掛かる受け入れ基準のラベルの対応。
  // **これが「どのベンチがどの基準に掛かるか」の唯一の宣言**で、両向きに突き合わせる
  // (表に無いベンチ・実在しないベンチ・共有モジュール側の基準との食い違いをすべて落とす)
  // **上限の項目名もベンチごとに持つ。** 共通の 'limitMs' を決め打ちしていたときは、
  // 時間以外を測るベンチ (採点の再現率は「件数」) を足した瞬間に、この表と実装が食い違った
  const BENCH_LABELS: Readonly<
    Record<string, { label: string; valueField: string; limitField: string }>
  > = {
    'bench-proxy.ts': { label: 'proxy-latency', valueField: 'addedMs', limitField: 'limitMs' },
    'bench-usage-aggregate.ts': {
      label: 'usage-aggregate',
      valueField: 'slowestMs',
      limitField: 'limitMs',
    },
    'bench-evaluation.ts': {
      label: 'evaluation-agreement',
      valueField: 'disagreedCases',
      limitField: 'limitDisagreedCases',
    },
    'bench-guardrail.ts': {
      label: 'guardrail-stop',
      valueField: 'elapsedMs',
      limitField: 'limitMs',
    },
    'bench-demo-ready.ts': { label: 'demo-ready', valueField: 'elapsedMs', limitField: 'limitMs' },
    'bench-concurrency.ts': {
      label: 'concurrency-error-rate',
      // **ゲート側の独立な比較は「≦ 上限」** (共通判定がその形しか扱わない)。基準の文の
      // 「< 1%」の境界は `concurrencyErrorRateProblem` が落とす
      valueField: 'errorPercent',
      limitField: 'limitErrorPercent',
    },
  };

  // ベンチが `process` に触れてよい形。**すべて純粋な読み取りだけ**で、
  // ここに無い形 (`process.exit` / 要素アクセス / 別名束縛 / `process.on('exit', …)` /
  // `Object.defineProperty(process, …)`) は「許可リストに無い」という 1 つの理由で落ちる
  const ALLOWED_PROCESS_USES = new Set(['process.env', 'process.cwd', 'process.execPath']);

  // ベンチが取り込んでよい相対でない指定子。**`node:*` をまとめて許さない** —
  // 実測で `import { exit } from 'node:process'` は `processUses` に 1 件も現れず、
  // 偽の結果 JSON を出してから `exit(0)` するだけでゲートが緑になった (773 件すべて緑)。
  // **エントリを足す差分は、その依存が import の副作用や終了経路を持たないかをレビューで確認する**
  // **この確認は「足すとき」だけでなく「その依存の major を上げるとき」にも要る** — 照合しているのは
  // 指定子の綴りなので、版が変わっても表は何も言わない。実際 `dotenv` の 17 → 18 で前提が動いた:
  // v17 の `lib/main.js` は `process.exit` / `child_process` / `process.on(` / `spawn` を 1 つも
  // 含まなかったが、v18 の `dist/index.cjs` (= `dotenv/config` が読む実体) は CLI を同梱しており
  // `process.exit` 6 / `child_process` 2 / `spawn` 4 / `process.kill` 2 / `process.on(` 1 を持つ。
  // `Module._load` をフックした実測では、`require('dotenv/config')` は **`child_process` を実際に
  // 読み込む**が、シグナルの購読は 0 件で、CLI 本体は `require.main === module` の内側にあるため
  // tsx / node のエントリ経由では起動しない。**いまは無害だが「副作用も終了経路も持たない」は
  // もう成り立っていない。**
  // **この注意書きは版を上げる差分には現れない**（`package.json` と lockfile しか動かず、ここの
  // 指定子の綴りは変わらないので、レビューがこの行へ誘導されることは無い）。誘導は
  // `CLAUDE.md` §3 の dotenv の項から一方向に張ってあり、**手順の実体はここに置く**（両方が
  // 相手を指すと、探しに来た人がどちらにも手順を見つけられない）。
  // **次に上げるときの手順**（上の数字はこれで測ったもの。約 10 行で済む）:
  //   1. `node -e` で `Module._load` を差し替えてから `require('dotenv/config')` し、
  //      読み込まれた組み込みモジュール名を集める → `child_process` 以外が増えていないか見る
  //   2. 同じ子プロセスで `process.listenerCount('SIGINT'|'SIGTERM'|'SIGHUP'|'SIGQUIT')` を
  //      import の前後で比べる → **0 から増えていないこと**（増えていたら CLI が無条件に走っている）
  //   3. `dist/index.cjs` を `grep -o` で数え、`process.exit` / `spawn` / `process.kill` の出現が
  //      `require.main === module` の内側に留まっているかをその場で読む
  // 1 か 2 が動いたら、このコメントの数字を更新したうえで**エントリを残すか外すかを判断する**。
  const ALLOWED_BENCH_PACKAGES = new Set([
    'dotenv/config',
    'autocannon',
    'node:child_process',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:os',
    'node:path',
  ]);

  // ベンチがアプリ本体から取り込んでよいモジュール (絶対パス)。**「`src/` の下なら許す」に
  // してはいけない** — `src/` はゲートの静的検査の走査対象ではないので、偽の合格 payload を
  // `console.log` してから `process.exit(0)` するモジュールを新設して 1 行 import するだけで、
  // ベンチが DB にも上流にも触れないまま Step2 の受け入れ基準を通せた (実測で 808 件すべて緑・
  // 件数も不変)。**エントリを足す差分は、その結線が import の副作用や終了経路を持たないかを
  // レビューで確認する**（除外表と同じ扱いのエスケープハッチ）。
  // **残る境界**: 見るのは直接の import 先だけで、その先が推移的に取り込むものは追わない。
  // ただしここに並ぶのはアプリ本体が実行時に使う結線なので、そこへ終了経路を足せば
  // アプリのテストが落ちる（新設した誰も使わないモジュールに隠す、という形は塞がる）
  // (指定子は拡張子を書かないので、解決結果と同じ「拡張子なしの絶対パス」で持つ)
  const ALLOWED_BENCH_SRC_MODULES = new Set(
    [
      'lib/prisma-client',
      'lib/tokens',
      // **定数だけのモジュール**（実行時コードを持たず、import は `lib/body-limits`（これも
      // 定数だけ）1 つ。副作用も終了経路も無い）。ベンチが受け入れ基準に関係する値
      // （しきい値の上限・レート制限の環境変数名）を**写さずに**読むために要る
      'lib/constants',
      'lib/proxy/upstream',
      'lib/evaluation/runner',
      'domain/types',
      // **金額の上限の定数**（`domain/money` は純粋な解析・整形の関数と定数だけで、
      // import も無く副作用も終了経路も持たない）。プロキシのベンチが「予算を持つ
      // エージェントの中継」を測るために、到達しない上限を**写さずに**読むために要る
      'domain/money',
      // **プラン別の上限の表**（`domain/plan` は `domain/types` だけを import する純粋な表と
      // 述語で、副作用も終了経路も持たない）。ガードレールのベンチが「ルール数の上限」を
      // **写さずに**読むために要る（上限は計測の主題ではないので標準の有料プランの値を使う）
      'domain/plan',
      'domain/evaluation/scores',
      'domain/evaluation/judge-output',
      'data/adapters/prisma',
      'data/ports',
      // **ガードレールの判定の唯一の入口**（発火から停止までを測るベンチが呼ぶ）。
      // import 時の副作用も終了経路も持たず、本番の 3 つの起点がすべてこの関数を通るので、
      // ベンチが「本番と同じ経路」を測れる（別の経路を測るベンチは基準の証拠にならない）
      'lib/guardrail/evaluate',
    ].map((name) => join(SCRIPTS_DIR, '..', 'src', name)),
  );

  // ゲートと共有モジュールが相対 import してよい先 (絶対パス)。**走査している集合そのもの**から
  // 導く（前方一致で許すと、走査が拡張子で絞っているぶんだけ許可のほうが広くなる）
  const scannedSharedModulePaths = new Set(
    sharedModuleNames().map((name) => join(SCRIPTS_DIR, 'lib', name)),
  );

  // ベンチのトップレベルの変数初期化子で呼んでよいもの。**定数を組み立てるだけの純粋な呼び出し**に限り、
  // **このファイルで宣言した関数は載せない** — 呼び出し先の本体は `topLevelInitializerEffects` の
  // 視界の外なので、ローカルの薄い包みを許すとその本体へ副作用を書けてしまう (実測: 許可リストに
  // 載っていた `intFromEnv` の本体に 1 行足すと、専用 DB のガードより前に 3 回走った)。
  // **エントリを足す差分は、その呼び出しが副作用を持たないかをレビューで必ず確認する**
  const ALLOWED_TOP_LEVEL_INITIALIZER_CALLS = new Set([
    'intFromEnv',
    'join',
    'process.cwd',
    'JSON.stringify',
    // 受け入れ基準の上限を整数の計算だけで導く純粋関数 (副作用を持たない)
    'maxDisagreedCases',
  ]);

  // 上のうち「このファイルで宣言されていない」ことまで求めるもの (共有モジュール由来であること)。
  // **ローカルに同名の関数を宣言すれば許可リストを満たせてしまう** ので、出どころまで固定する
  const SHARED_INITIALIZER_CALLS: Readonly<Record<string, string>> = {
    intFromEnv: 'bench-criteria.mjs',
    maxDisagreedCases: 'step3-criteria.mjs',
  };

  // ベンチのトップレベルに置いてよい文の種類。**許す側を列挙する** —
  // 禁じたい形 (条件・繰り返し・try・ラベル文) を綴りで並べると 1 つ漏らすたびに静かな穴になる
  const ALLOWED_TOP_LEVEL_KINDS = new Set([
    'ImportDeclaration',
    'VariableStatement',
    'FunctionDeclaration',
    'InterfaceDeclaration',
    'TypeAliasDeclaration',
    'ExpressionStatement',
  ]);

  it('ベンチは受け入れ基準の実行をトップレベルで共有モジュールに任せる', async () => {
    // 表に載っているベンチが実在し、実在するベンチが表に載っていること (両向き)
    expect(Object.keys(BENCH_LABELS).sort(), '表とベンチの一覧が食い違う').toEqual(
      benchScriptNames().sort(),
    );
    const labels = Object.values(BENCH_LABELS).map((entry) => entry.label);
    // **基準の表のラベルと過不足なく一致すること** — 片方にだけ足すと「誰も掛けない基準」か
    // 「基準の無いベンチ」が黙って生まれる (実測: 表に 3 本目を足しても検査は 1 件も増えなかった)
    expect([...labels].sort(), 'ベンチのラベルと基準の表が食い違う').toEqual(benchLabels().sort());
    // 重複したラベルを許すと 2 本が同じ基準を指して片方の基準が消える
    expect(new Set(labels).size, 'ラベルが重複している').toBe(labels.length);
    for (const [bench, { label }] of Object.entries(BENCH_LABELS)) {
      // そのベンチのパス
      const path = join(SCRIPTS_DIR, bench);
      // **runBench を、そのベンチのラベルで、トップレベルの式文として呼ぶこと。**
      // 判定も出力も終了コードも共有モジュールが持つので、ここを外すと受け入れ基準を誰も強制しない
      expect(
        callsFunction(path, 'runBench', {
          atTopLevel: true,
          importedFrom: 'bench-criteria.mjs',
          literalArgument: { index: 0, value: label },
          identifierArgument: { index: 1, value: 'main' },
        }),
        `${bench} が runBench('${label}', main) をトップレベルの式文として呼んでいない`,
      ).toBe(true);
      // トップレベルに条件・繰り返し・try を置けないこと。
      // **「呼んでいるか」だけでは足りない** — 実測で、呼び出しの**手前**に
      // `if (!process.env.BENCH_STRICT) process.exit(0);` を 1 行足すだけで、呼び出しを
      // 残したまま一度も実行されない状態が作れた (全件緑・件数も不変・出力も無しで exit 0)
      for (const kind of topLevelStatementKinds(path))
        expect(
          ALLOWED_TOP_LEVEL_KINDS.has(kind),
          `${bench} のトップレベルに ${kind} がある (受け入れ基準の実行を条件付きにできる)`,
        ).toBe(true);
      // **トップレベルの実引数はリテラルか素の識別子だけ。** 実引数は呼び出しより先に評価されるので、
      // `requireContractDatabase(副作用のある関数())` と書けば専用 DB のガードより前に必ず走る
      // (実測で 773 件すべて緑のまま、ガードより先に同期のファイル書き込みが実行された)
      for (const call of topLevelCallArgumentKinds(path))
        for (const kind of call.kinds)
          expect(
            kind === 'literal' || kind === 'identifier',
            `${bench} の ${call.name} にリテラルでも識別子でもない実引数がある`,
          ).toBe(true);
      // `process` は純粋な読み取りだけ。**禁じたい綴りを並べない** — 実測で
      // `process['exit'](0)` も `const { exit } = process;` も `process.on('exit', …)` も
      // 全件緑のまま素通りし、受け入れ基準を 1 つも掛けずに exit 0 にできた
      for (const use of processUses(path))
        expect(
          ALLOWED_PROCESS_USES.has(use),
          `${bench} の ${use} は許していない (判定より先に終了コードを決められる)`,
        ).toBe(true);
      // トップレベルの変数初期化子は定数を組み立てるだけ。**ここが視界の外だった** — 実測で
      // `const CLEARED = await CLIENT.$executeRaw\`TRUNCATE …\`;` を専用 DB のガードより前へ
      // 置くと全件緑のまま、ガードが約束する「1 件も書かずに止める」が破れた
      for (const effect of topLevelInitializerEffects(path)) {
        expect(
          ALLOWED_TOP_LEVEL_INITIALIZER_CALLS.has(effect),
          `${bench} のトップレベルの初期化子が ${effect} を起こす`,
        ).toBe(true);
        // 共有モジュール由来を求めるものは、出どころまで見る (同名のローカル宣言を落とす)
        const from = SHARED_INITIALIZER_CALLS[effect];
        if (from !== undefined)
          expect(
            callsFunction(path, effect, { importedFrom: from }),
            `${bench} の ${effect} が ${from} 由来でない`,
          ).toBe(true);
      }
      // 相対 import の先は共有モジュール (scripts/lib) かアプリ本体 (src) だけ。
      // **ここも視界の外だった** — 実測で `scripts/preflight.mjs` に `process.exit(0)` を置いて
      // `import './preflight.mjs';` を 1 行足すと、全件緑のまま出力ゼロで exit 0 になった
      // (ESM は import した側のどのトップレベル文よりも先に評価される)
      for (const specifier of foreignModuleSpecifiers(path)) {
        // 相対でない指定子は許可リストで絞る。**「相対でなければ許す」では足りない** —
        // 実測で `package.json` の `imports` を使った `#warmup` が素通りし、その先に置いた
        // `process.exit(0)` でガードもベンチも走らないまま exit 0 になった (773 件すべて緑)
        if (!specifier.startsWith('.')) {
          expect(
            ALLOWED_BENCH_PACKAGES.has(specifier),
            `${bench} が ${specifier} を取り込んでいる (import の副作用や終了経路を持ち込める)`,
          ).toBe(true);
          continue;
        }
        // 解決先はアプリ本体の**許可した結線だけ**。**「`src/` の下なら許す」では足りない** —
        // `src/` は `process` の走査対象ではないので、そこへ偽の合格 payload を出して
        // `process.exit(0)` するモジュールを新設し 1 行 import すると、ベンチが DB にも上流にも
        // 触れないまま受け入れ基準を通せた (実測で 808 件すべて緑・件数も不変)
        expect(
          ALLOWED_BENCH_SRC_MODULES.has(resolve(dirname(path), specifier)),
          `${bench} が ${specifier} を取り込んでいる (import の副作用で判定を飛ばせる)`,
        ).toBe(true);
      }
      // **トップレベルで実行するのはこの 2 つだけ、この順で。** 専用 DB のガードが先で、
      // 受け入れ基準の実行が後 (順番が入れ替わると開発 DB を TRUNCATE してから止まる)。
      // 余計な実行を足せないので、判定より先に何かを走らせる形もここで落ちる
      expect(topLevelCallNames(path), `${bench} のトップレベルの実行が想定と違う`).toEqual([
        'requireContractDatabase',
        'runBench',
      ]);
      // 式文がすべてその呼び出しであること (`process.exitCode = 0` のような代入を残さない)
      expect(
        topLevelStatementKinds(path).filter((kind) => kind === 'ExpressionStatement').length,
        `${bench} のトップレベルに呼び出し以外の式文がある`,
      ).toBe(2);
    }
  });

  // bench-criteria が export する関数のうち、**受け入れ基準の判定ではない**もの。
  // 判定は残らず BENCH_CRITERIA のどれかで使われていなければならず、外すには export ごと消すしかない
  const JUDGE_EXCLUSIONS: Readonly<Record<string, string>> = {
    benchLabels: '基準を持つベンチのラベルの一覧 (網羅の照合に使う導出)',
    intFromEnv: '環境変数の読み取り (基準ではなく入力の検証)',
    intFromEnvValue: '同上 (値を受け取る側。テストから直接呼ぶために分けてある)',
    benchCriteriaFields: '基準の読み取り項目を検査へ渡すための導出',
    benchCriteriaJudges: 'この検査そのものが使う導出',
    judgeBenchPayload: '基準を掛ける側 (判定を呼ぶ人)',
    runBench: '計測・出力・終了コードの入口',
  };

  it('bench-criteria の判定はすべてどれかの基準で使われている', async () => {
    // 判定の名前は**モジュールの export から導く** (一覧を手書きすると、足した判定が黙って外れる)
    const criteria = await importSharedModule('bench-criteria.mjs');
    // 表のどれかで実際に使われている判定 (関数の同一性で持つ)
    const used = benchCriteriaJudges();
    // 1 つも読めなければ導出が壊れている (fail-closed)
    expect(used.size, '基準に使われている判定が 0 件').toBeGreaterThan(0);
    // **命名 (`*Problem`) で絞らない** — 実測で、判定を `non2xxGuard` へ改名して基準の行と
    // 挙動の表の行を同時に削ると、赤 0 件・痕跡は it.each の 2 件減だけで通った。
    // 判定でないものは理由付きの除外表に登録する (1 行増える差分がレビューに出る)
    const judgements = Object.entries(criteria).filter(
      (entry): entry is [string, (...args: never[]) => unknown] =>
        typeof entry[1] === 'function' && JUDGE_EXCLUSIONS[entry[0]] === undefined,
    );
    // 1 つも無ければ導出が壊れている (fail-closed)
    expect(judgements.length, '判定を 1 つも読めない').toBeGreaterThan(0);
    for (const [name, judge] of judgements)
      expect(used.has(judge), `${name} はどの基準にも使われていない`).toBe(true);
    // 除外表の中身も確かめる (実在しない名前で表を膨らませない / 理由の無い登録を許さない)
    for (const [name, reason] of Object.entries(JUDGE_EXCLUSIONS)) {
      expect(typeof criteria[name], `除外表の ${name} は実在しない`).toBe('function');
      expect(reason.trim().length, `除外表の ${name} に理由が無い`).toBeGreaterThan(0);
    }
  });

  it('ゲートはベンチごとに結果の JSON を検査する', () => {
    // 最新 Step のゲート (ベンチを流すのはここだけ)。**綴りを固定しない** —
    // 次の Step のゲートが増えた瞬間、この検査は古いゲートを見続けたまま緑になる
    const gate = join(SCRIPTS_DIR, latestGateScriptName());
    // 0 本なら空振りで緑になる (fail-closed)
    expect(Object.keys(BENCH_LABELS).length, 'ベンチが 1 本も無い').toBeGreaterThan(0);
    for (const [bench, { label, valueField, limitField }] of Object.entries(BENCH_LABELS)) {
      // そのベンチを起動する npm スクリプト名 (ゲートが実際に流すコマンドの正本)
      const script = benchNpmScriptOf(bench);
      // **新しい最終防衛線も、他の結線と同じ強さで見張る** — ここが無いと、ゲートから
      // `benchOutputProblems` の呼び出しを丸ごと外して終了コードだけを見る形へ戻しても
      // 赤が 1 件も出なかった (実測で 773 件すべて緑・件数も不変)
      expect(
        callsFunction(gate, 'exitIfFailures', {
          atTopLevel: true,
          importedFrom: 'run-npm-steps.mjs',
          argument: {
            index: 1,
            callOf: ['benchOutputProblems'],
            importedFrom: 'gate-report.mjs',
            // ラベルと比較する項目名はそのベンチのもので、上限との独立比較に要る 4 項目が揃い、
            // **材料 (status / stdout) はそのベンチを実際に流した結果を展開したものであること**。
            // 実測で、展開をリテラルの `status: 0` / `stdout: '<偽の結果 JSON>'` へ差し替えると、
            // ベンチを 1 本も起動せずにゲートが緑になった (779 件すべて緑・件数も不変)。
            // 比較する項目名も固定する — `valueField: 'limitMs'` の 1 語書き換えで
            // `limitMs <= limit` という恒真式になり、独立比較が消えた (実測)
            objectArgument: {
              index: 0,
              literals: { label, valueField, limitField },
              keys: ['label', 'valueField', 'limitField', 'limit'],
              // 材料は展開でしか運べない (手で書いた `status: 0` / `stdout: '…'` を許さない)
              forbiddenKeys: ['status', 'stdout'],
              spreadOf: {
                callOf: 'runNpmCapturingStdout',
                importedFrom: 'run-npm-steps.mjs',
                arrayArgument: { index: 0, values: ['run', script] },
              },
            },
          },
        }),
        `gate-step2.mjs が ${label} を実際に流してその結果を benchOutputProblems で検査していない`,
      ).toBe(true);
    }
  });

  it.each(
    Object.entries(BENCH_PAYLOADS).flatMap(([label, entry]) =>
      entry.breaks.map((patch, index) => [label, index, patch] as const),
    ),
  )(
    '素の Node でも基準を破れば passed: false と非 0 終了: %s #%i',
    (label, _index, patch) => {
      // **これが「基準が本当に強制されているか」の実行時の担保。全基準を 1 本ずつ破って回す** —
      // 最初の 1 基準だけを破っていたときは、残りの判定に
      // `if (process.env.NODE_ENV === 'production') return null;` を入れても全件緑だった (実測)。
      // 静的検査はどれも「その綴りがあるか」しか見ないので、共有モジュールの中に
      // `if (process.env.NODE_ENV !== 'test') payload.slowestMs = 0;` を 1 行入れるだけで
      // 受け入れ基準が完全に無効化されるのに全件緑だった (実測)。**vitest の印と NODE_ENV を
      // 落とした子プロセス**で、基準を破る実測値を実際に通して落ちることを確かめる
      const broken = { ...BENCH_PAYLOADS[label].ok, ...patch };
      const run = runBenchInCleanChild(label, broken);
      // 基準を満たしていないと出ること
      expect(run, `${label} が素の Node で passed: false にならない`).toContain('"passed":false');
      // **実測値がそのまま出ていること** (テストのときだけ本物を使う分岐を落とす)
      for (const [field, value] of Object.entries(broken))
        expect(run, `${label} の ${field} が書き換えられている`).toContain(
          `${JSON.stringify(field)}:${JSON.stringify(value)}`,
        );
      // 非 0 で終わること (ゲートは終了コードも見る)
      expect(run, `${label} が素の Node で非 0 終了しない`).toContain('EXIT_CODE=1');
      // **既定の 5 秒のまま放置しない** — `runBenchInCleanChild` が起こす子の上限は
      // `CHILD_TIMEOUT_MS`（180 秒）なので、既定だと子が張り付いたときに vitest の
      // 「Test timed out in 5000ms」が先に出て原因が消える（子は 1 本）
    },
    testBudgetFor(1),
  );

  it.each(Object.keys(BENCH_PAYLOADS))(
    '素の Node で基準を満たせば passed: true と終了コード据え置き: %s',
    (label) => {
      // 片側だけだと「常に落とす」実装でも緑にできるので、通る側も見る
      const run = runBenchInCleanChild(label, BENCH_PAYLOADS[label].ok);
      expect(run).toContain('"passed":true');
      expect(run).toContain('EXIT_CODE=undefined');
    },
    // 上と同じ理由で既定の 5 秒を使わない（子は 1 本）
    testBudgetFor(1),
  );

  it('挙動を確かめる表がベンチのラベルを網羅している', () => {
    // **3 本目のベンチを足して表に書き忘れると、そのベンチは挙動を 1 件も固定されないまま出荷される**
    expect(Object.keys(BENCH_PAYLOADS).sort(), '挙動の表と基準の表が食い違う').toEqual(
      benchLabels().sort(),
    );
  });

  it('ベンチが取り込んでよいアプリ本体のモジュールは実在し、実際に使われている', () => {
    // 0 本なら空振りで緑になる (fail-closed)
    expect(ALLOWED_BENCH_SRC_MODULES.size, '許可リストが空').toBeGreaterThan(0);
    // ベンチが実際に取り込んでいる先 (絶対パス)
    const imported = new Set(
      benchScriptNames().flatMap((bench) =>
        foreignModuleSpecifiers(join(SCRIPTS_DIR, bench))
          .filter((specifier) => specifier.startsWith('.'))
          // **解決の基点は前向きの検査と同じ「そのファイルのディレクトリ」にする** —
          // `SCRIPTS_DIR` 固定だと、ベンチをサブディレクトリへ移した瞬間に逆向きだけが
          // 別の場所を指して「誰も取り込んでいない」と誤検出する
          .map((specifier) => resolve(dirname(join(SCRIPTS_DIR, bench)), specifier)),
      ),
    );
    for (const modulePath of ALLOWED_BENCH_SRC_MODULES) {
      // 指定子は拡張子を書かないので、ファイルかディレクトリの index かを見る。
      // **実在しないエントリを放置すると、綴り違いのまま許可だけが広がる**
      expect(
        existsSync(`${modulePath}.ts`) || existsSync(join(modulePath, 'index.ts')),
        `${modulePath} は実在しない (許可リストの綴りが古い)`,
      ).toBe(true);
      // **逆向きも見る** — 使っていないエントリを先に足しておける形にすると、
      // 「あとで使う」名目で許可だけを広げられる (除外表を両向きに突き合わせるのと同じ流儀)
      expect(imported.has(modulePath), `${modulePath} はどのベンチも取り込んでいない`).toBe(true);
    }
  });

  // ゲートと共有モジュールが `process` に触れてよい形 (実測した現在の使用がそのまま入る)。
  // **ベンチと同じく「許す側」を列挙する** — 綴りを並べる形に戻すと、実測で
  // `process['exit'](0)` を 1 行足すだけでゲート全体が無言の no-op になり全件緑だった
  const ALLOWED_GATE_PROCESS_USES = new Set([
    'process.env',
    'process.cwd',
    'process.exit',
    'process.exitCode',
    'process.platform',
    'process.stdout',
    // **純粋な読み取り**（いま動いている Node の実行ファイルのパス）。Step7 の共有モジュール
    // `demo-flow.mjs` が本番ビルドを子プロセスとして起こすのに使う（ベンチ側の許可リストには
    // 元からあり、同じ形がゲート側の走査対象にも現れたので足した）
    'process.execPath',
  ]);

  // ゲートと共有モジュールが取り込んでよい相対でない指定子
  // **`node:net` は Step7 で足した** — `demo-flow.mjs` が空きポートを 1 つ取るために使う
  // （import の副作用も終了経路も持たない標準モジュール。ベンチ側の許可リストには元からある）
  const ALLOWED_GATE_PACKAGES = new Set([
    'node:child_process',
    'node:fs',
    'node:net',
    'node:os',
    'node:path',
  ]);

  it('scripts 配下の ESM の process の使い方は許可リストの形だけ', () => {
    // **対象は `scripts/` 配下の ESM すべて** — 綴り (`gate-step<数字>.mjs`) で絞っていたときは、
    // 契約テストの入口ガード `require-contract-env.mjs` がどの許可リストにも入らず、
    // 先頭に `process.exit(0)` を足すだけで「1 件も検証していないのに緑」にできた (実測)
    const paths = scriptModulePaths();
    // 0 本なら空振りで緑になる (fail-closed)
    expect(paths.length, '検査対象が 1 つも無い').toBeGreaterThan(0);
    for (const path of paths)
      for (const use of processUses(path))
        expect(
          ALLOWED_GATE_PROCESS_USES.has(use),
          `${path} の ${use} は許していない (要素アクセス・別名束縛で終了経路を隠せる)。` +
            `constructor は不透明なホップとして数えている — 例外の型名が要るなら error.name を使う`,
        ).toBe(true);
  });

  it('scripts 配下の ESM の import 先は許可リストだけ', () => {
    // 対象は `scripts/` 配下の ESM すべて (理由は上の検査と同じ)
    const paths = scriptModulePaths();
    // 0 本なら空振りで緑になる (fail-closed)
    expect(paths.length, '検査対象が 1 つも無い').toBeGreaterThan(0);
    for (const path of paths)
      for (const specifier of foreignModuleSpecifiers(path)) {
        // 相対でない指定子は許可リストで絞る
        if (!specifier.startsWith('.')) {
          expect(
            ALLOWED_GATE_PACKAGES.has(specifier),
            `${path} が ${specifier} を取り込んでいる (import の副作用で判定を飛ばせる)`,
          ).toBe(true);
          continue;
        }
        // 相対 import の先は**走査している共有モジュールそのもの**だけ。**実測で、
        // `scripts/preflight.mjs` に `process.exit(0)` を置いて 1 行 import するだけで
        // ゲートが無言の no-op になった**。**前方一致で許してはいけない** — 走査は拡張子
        // `.mjs` で絞るのに許可はパスの前置詞だけを見ていたため、`scripts/lib/preflight.js`
        // (`package.json` に `type` が無いので CJS) を置いて取り込むと、そのファイルは
        // どの許可リストの対象にもならないまま評価され、808 件すべて緑・件数も不変のまま
        // ゲートが無言で exit 0 になった (実測)。**許可は走査済みの集合から導く**ので、
        // 見ていないものは原理的に取り込めない (拡張子でも深さでも同じ不等号が生まれない)
        expect(
          scannedSharedModulePaths.has(resolve(dirname(path), specifier)),
          `${path} が ${specifier} を取り込んでいる (import の副作用で判定を飛ばせる)`,
        ).toBe(true);
      }
  });

  it('scripts 配下の ESM の process.exit は非 0 だけ', () => {
    // ゲートは正当に process.exit(1) を使うので、使用そのものは禁じられない。
    // **`process.exit(0)` を 1 行足すだけでゲート全体が無言で成功終了した** (実測で全件緑・
    // CI の gate ジョブも緑のまま、Step0〜Step2 の全基準が一度も走らない)
    const paths = scriptModulePaths();
    // 0 本なら空振りで緑になる (fail-closed)
    expect(paths.length, '検査対象が 1 つも無い').toBeGreaterThan(0);
    for (const path of paths)
      for (const argument of processExitArguments(path))
        expect(
          /^[1-9][0-9]*$/.test(argument),
          `${path} に process.exit(${argument}) がある (非 0 の数値リテラルだけを許す)`,
        ).toBe(true);
  });

  // ベンチのラベルごとの上限 (受け入れ基準の正本から引く。positive control が食い違いを落とす)
  const BENCH_LIMIT_BY_LABEL: Readonly<Record<string, number>> = {
    'usage-aggregate': USAGE_AGGREGATE_MAX_MS,
    'proxy-latency': PROXY_ADDED_LATENCY_P95_MAX_MS,
    'evaluation-agreement': maxDisagreedCases(EVALUATION_BENCH_CASE_COUNT),
    'guardrail-stop': GUARDRAIL_STOP_MAX_MS,
    'demo-ready': DEMO_READY_MAX_MS,
    'concurrency-error-rate': CONCURRENCY_MAX_ERROR_PERCENT,
  };

  // 受け入れ基準を**すべて満たす**テストレポートを組み立てる (シムに書かせる中身)。
  // **名前の形はここで組み立てるが、組み立てた結果を判定に通して空を要求する**ので、
  // 形がずれたら「基準を満たすはずのレポートが落ちる」という形で必ず赤くなる (写しが腐らない)
  function fullMarksReport(
    dropPricedIndex = -1,
    drop: { crossTenantAt?: number; derivation?: boolean } = {},
  ): string {
    // 料金表の正本 (ゲートが読むのと同じファイル)
    const models = (
      JSON.parse(
        readFileSync(join(ROOT, 'src', 'domain', 'pricing', 'vendor-prices.json'), 'utf8'),
      ) as { models: { provider: string; model: string }[] }
    ).models;
    // 料金表のモデルごとのテスト名
    const priced = models.map(({ provider, model }) => `${PRICE_TEST_PREFIX}${provider} ${model}`);
    // 基準が名前で探すテスト (RBAC 行列 × 料金表の全モデル)。
    // 落とすときは**指定した 1 件だけ**を外す (件数の下限は下の埋めで保たれるので、
    // 「全モデルを見ているか」だけが試される)。**末尾 1 件だけを試すのでは足りない** —
    // 末尾を含んだまま縮める変異 (`readPricedModels().slice(1)`・偶数添字だけを残す形) は
    // どちらも 128 件すべて緑のまま通った (実測)。添字ごとに 1 本ずつ試せば、
    // 「どれか 1 つでも見ていないモデルがある」形はその添字の probe が必ず落とす
    // 除外理由ごとのテスト名。**ゲートは Prisma スキーマから読むので、ここは
    // ドメイン側の enum から組み立てる** — 同じ経路で組み立てると、片方が壊れても
    // 両方が同じだけ縮んで空振りのまま緑になる (手がかりを変えるのが要点)
    const exclusions = Object.values(EvaluationExclusionReason).map(
      (reason) => `${EXCLUSION_TEST_PREFIX}${reason}`,
    );
    // ルールの種別ごとの発火テスト名。**ここも手がかりを変える** (ゲートは Prisma スキーマ、
    // ここはドメイン側の enum)。同じ経路で組み立てると両方が同じだけ縮んで空振りで緑になる
    const firings = Object.values(RuleKind).map(
      (kind) => `${FIRING_TEST_PREFIX}${kind} が発火する`,
    );
    // 連鎖の壊れ方ごとの改ざん検知テスト名。**実際の名前と同じく手がかりが離れた形**にする
    // (接頭辞のすぐ後ろに壊れ方を置く形で組み立てると、離れた形を照合できない退行に気付けない)
    const tampers = Object.values(AuditChainBreak).map(
      (reason) => `${TAMPER_TEST_PREFIX}壊すと ${reason} で落ちる`,
    );
    // 越境アクセスのテスト名 (Step6)。**下限ぶんだけ組み立てる** — ここを実際の表から
    // 導くと、表が縮んだときに材料も一緒に縮んで空振りのまま緑になる (手がかりを変える)
    const crossTenant = Array.from(
      { length: CROSS_TENANT_MIN_CASES },
      (_v, i) => `${CROSS_TENANT_TEST_PREFIX}GET /resource-${i} は 404`,
    );
    // Webhook の冪等性のテスト名 (Step6)。同じく下限ぶん
    const idempotency = Array.from(
      { length: IDEMPOTENCY_MIN_CASES },
      (_v, i) => `${IDEMPOTENCY_TEST_PREFIX}再送 ${i} は 1 回しか反映しない`,
    );
    const named = [
      ...ROLES.flatMap((role) =>
        ACTIONS.map((action) => `${MATRIX_TEST_PREFIX}${role} × ${action}`),
      ),
      ...priced.filter((_name, index) => index !== dropPricedIndex),
      ...exclusions,
      ...firings,
      ...tampers,
      // E2E は 1 本だけ (Step4 の受け入れ基準 3)
      GUARDRAIL_E2E_TEST_NAME,
      // 突合も 1 本だけ (Step5 の受け入れ基準 3)。**説明が後ろに続く形**にする
      // (実際のテスト名と同じく、完全一致を前提にしない)
      `ダッシュボード ${RECONCILE_TEST_NAME}（独立に数え直す）`,
      // 越境の導出と表を突き合わせるテスト (Step6 の受け入れ基準 1 の前半)。
      // **群とは別の名前**で要求されるので、落とせば群が揃っていても赤くなる
      ...(drop.derivation === true ? [] : [`テナント越境 ${CROSS_TENANT_DERIVATION_TEST_NAME}`]),
      // 越境の群 (下限ぶん。1 件落とすと件数が下限を割る)
      ...crossTenant.filter((_name, index) => index !== drop.crossTenantAt),
      // 冪等性の群 (下限ぶん)
      ...idempotency,
    ];
    // 件数の下限まで埋める
    const filler = Math.max(0, REQUIRED_PASSED_TESTS - named.length);
    const assertionResults = [
      ...named.map((fullName) => ({ fullName, status: 'passed' })),
      ...Array.from({ length: filler }, (_v, i) => ({ fullName: `埋め ${i}`, status: 'passed' })),
    ];
    // vitest の JSON レポートの形
    const report = {
      numPassedTests: assertionResults.length,
      numFailedTests: 0,
      numPendingTests: 0,
      testResults: [{ assertionResults }],
    };
    // **組み立てた結果が意図どおりであることを、判定そのものに確かめさせる**。
    // 最新 Step の判定に通すので、前の Step の基準もそこから引き継がれて確かめられる
    const failures = evaluateStep7Report({
      testStatus: 0,
      report,
      requiredPassedTests: REQUIRED_PASSED_TESTS,
      roles: ROLES,
      actions: ACTIONS,
      matrixPrefix: MATRIX_TEST_PREFIX,
      models,
      pricePrefix: PRICE_TEST_PREFIX,
      reasons: Object.values(EvaluationExclusionReason),
      exclusionPrefix: EXCLUSION_TEST_PREFIX,
      kinds: Object.values(RuleKind),
      firingPrefix: FIRING_TEST_PREFIX,
      breaks: Object.values(AuditChainBreak),
      tamperPrefix: TAMPER_TEST_PREFIX,
      e2eTestName: GUARDRAIL_E2E_TEST_NAME,
      reconcileTestName: RECONCILE_TEST_NAME,
      crossTenantDerivationTestName: CROSS_TENANT_DERIVATION_TEST_NAME,
      crossTenantPrefix: CROSS_TENANT_TEST_PREFIX,
      crossTenantMinCount: CROSS_TENANT_MIN_CASES,
      idempotencyPrefix: IDEMPOTENCY_TEST_PREFIX,
      idempotencyMinCount: IDEMPOTENCY_MIN_CASES,
      // カバレッジは満点の材料で確かめる (欠けさせる形は別の probe が見る)
      coverageSummary: JSON.parse(coverageMaterial()),
      coverageMinPercent: COVERAGE_MIN_PERCENT,
      // 既知バグ 0 は「問題なし」の材料で確かめる (**実物のリポジトリは別の it が見る**。
      // ここで実物を読むと、組み立ての形の検査が既知バグの有無で揺れる)
      knownBugs: { docProblems: [], openIssues: [], markerHits: [], scannedFiles: 1 },
    });
    // 落としたなら基準を満たさないこと、満点なら満たすこと
    if (dropPricedIndex >= 0 || drop.crossTenantAt !== undefined || drop.derivation === true)
      expect(
        failures.length,
        '1 件を落としたのに基準を満たしてしまう (組み立ての形が古い)',
      ).toBeGreaterThan(0);
    else
      expect(failures, '満点のつもりのレポートが基準を満たしていない (組み立ての形が古い)').toEqual(
        [],
      );
    return JSON.stringify(report);
  }

  it.each(gateScriptNames())(
    '%s は壊した検証 1 つごとに必ず落ちる (綴りを見ない negative control)',
    (name) => {
      // 満点のレポート (シムに書かせる)
      const report = fullMarksReport();
      // ベンチが出す JSON の材料 (npm スクリプト名ごと)
      const benches = benchMaterials();
      // 出力を読んで判定するもの (E2E / Lighthouse) が出す中身
      const printed = printedMaterials();
      // **positive control**: 何も壊さなければ 0 で終わる。これが検査自身の射程を固定する —
      // 射程が縮めば「壊していないのに落ちる」か「壊したのに落ちない」のどちらかで赤くなる
      // カバレッジの合計（満点）。ゲートは `--coverage.reportsDirectory=` で出力先を指定するので、
      // シムはその場所へこれを書く（指定が消えればゲートは「読めません」で赤くなる）
      const coverage = coverageMaterial();
      const clean = runGateUnderShim(name, '', report, benches, printed, coverage);
      expect(clean.status, `${name} がすべて成功しても緑にならない`).toBe(0);
      // **流すと書いてあるもの**を、実行とは別の手がかり（ソース）から導く。
      // **「実際に呼ばれたもの」から検査対象を導いてはいけない** — 途中で黙って終わる変異は
      // 呼び出しの一覧ごと縮むので、検査も一緒に縮んで素通りする（実測で、判定の直後に
      // 反射的な終了を置く変異も、audit の判定を `if (false && …)` にする変異も全件緑で通った）
      const required = requiredNpmFor(name);
      // 1 つも無ければ導出が壊れている (fail-closed)
      expect(required.length, `${name} が流す npm を 1 つも導けない`).toBeGreaterThan(0);
      // **書いてあるものは実際に流していること** — 途中で黙って終わる形をここで落とす
      for (const script of required)
        expect(clean.invoked, `${name} が ${script} を流していない`).toContain(script);
      // **逆向きも突き合わせる** — 導出（ソースの読み方）が黙って縮むと、実際には流している
      // 検証が negative control の対象から外れて「壊しても落ちない」窓が開く。実行側にしか
      // 現れない npm があればここで落ちる
      for (const script of new Set(clean.invoked))
        expect(
          required,
          // **直し方を文言に書く** — この赤は「npm へ渡す引数をソースから読めなかった」
          // という意味で、検出網を緩める方向へ行かせないために直し方を添える
          `${name} が導出に無い ${script} を流している` +
            ' (npm へ渡す引数は実行ヘルパーの呼び出し位置に直接書く。変数へ括り出したり' +
            'ヘルパーを別名で import したりすると、ソースから読めず検査の対象から外れる)',
        ).toContain(script);
      // **negative control**: 流すと書いてあるものを 1 つずつ壊す
      for (const target of required) {
        const broken = runGateUnderShim(name, target, report, benches, printed, coverage);
        expect(
          typeof broken.status === 'number' && broken.status !== 0,
          `${name} が ${target} の失敗を無視して成功終了した (終了コード ${String(broken.status)})`,
        ).toBe(true);
      }
    },
    testBudgetFor(MAX_SHIM_CHILDREN),
  );

  it.each(pricedModelIndexes())(
    '最新のゲートは料金表の %i 番目のモデルの欠落を見逃さない (レポート側の negative control)',
    (dropAt) => {
      // **npm はすべて成功させたまま、レポートの中身だけを 1 件欠かす。**
      // 検証コマンドの成否を 1 つずつ壊す行列は「ゲートが何を流すか」しか見ないので、
      // 「料金表の一部しか見ない」変異 (`readPricedModels().slice(0, 1)` など) は
      // どの npm も失敗しないまま素通りする。欠落を見逃さないことはここで固定する。
      // **添字ごとに 1 本ずつ試す** — 末尾だけだと `slice(1)` のように末尾を含んだまま
      // 縮める変異が、ゲートを落としたまま (= 検査は緑のまま) 通る。料金表は小さいので
      // 全添字を回しても数秒で、これで「部分集合にする」族がまとめて閉じる
      const short = runGateUnderShim(
        latestGateScriptName(),
        '',
        fullMarksReport(dropAt),
        benchMaterials(),
        printedMaterials(),
        coverageMaterial(),
      );
      // 非 0 で終わっていること (0 なら料金表の全モデルを見ていない)
      expect(
        typeof short.status === 'number' && short.status !== 0,
        `料金表の ${dropAt} 番目のモデルの欠落を見逃した (終了コード ${String(short.status)})`,
      ).toBe(true);
    },
    testBudgetFor(1),
  );

  it.each(['statements', 'branches', 'functions', 'lines'])(
    '最新のゲートはカバレッジの %s が下限を割ることを見逃さない (受け入れ基準 4)',
    (metric) => {
      // **npm はすべて成功させたまま、カバレッジの合計だけを 1 指標ぶん下限未満にする。**
      // 検証コマンドの成否を壊す行列では「1 指標しか見ていない」「読めなくても緑」といった
      // 緩め方が素通りする（どの npm も失敗しない）。4 指標すべてに掛かっていることはここで固定する
      const low = runGateUnderShim(
        latestGateScriptName(),
        '',
        fullMarksReport(),
        benchMaterials(),
        printedMaterials(),
        coverageMaterial(metric),
      );
      // 非 0 で終わっていること（0 ならその指標を見ていない）
      expect(
        typeof low.status === 'number' && low.status !== 0,
        `カバレッジの ${metric} が下限未満なのに見逃した (終了コード ${String(low.status)})`,
      ).toBe(true);
    },
    testBudgetFor(1),
  );

  it(
    '最新のゲートはカバレッジが測れていないことを見逃さない (受け入れ基準 4)',
    () => {
      // **カバレッジを 1 行も書かせない。** 「読めないから緑」に倒れていれば、
      // `--coverage` を外す変異（＝1 行も測らない）がそのまま基準を満たしてしまう
      const missing = runGateUnderShim(
        latestGateScriptName(),
        '',
        fullMarksReport(),
        benchMaterials(),
        printedMaterials(),
        '',
      );
      expect(
        typeof missing.status === 'number' && missing.status !== 0,
        `カバレッジが無いのに見逃した (終了コード ${String(missing.status)})`,
      ).toBe(true);
    },
    testBudgetFor(1),
  );

  it(
    '最新のゲートは越境テストの導出の照合が無いことを見逃さない (受け入れ基準 1)',
    () => {
      // **群（`越境: `）は満点のまま、導出と表を突き合わせるテストだけを外す。**
      // 群だけを見る形だと、表から 1 件消す変異は「要求も一緒に縮む」ので素通りする
      // （流れたものから期待を導く形）。導出のテストを別に要求していることをここで固定する
      const noDerivation = runGateUnderShim(
        latestGateScriptName(),
        '',
        fullMarksReport(-1, { derivation: true }),
        benchMaterials(),
        printedMaterials(),
        coverageMaterial(),
      );
      expect(
        typeof noDerivation.status === 'number' && noDerivation.status !== 0,
        `越境の導出の照合が無いのに見逃した (終了コード ${String(noDerivation.status)})`,
      ).toBe(true);
    },
    testBudgetFor(1),
  );

  it(
    '最新のゲートは越境テストが 1 件欠けることを見逃さない (受け入れ基準 1)',
    () => {
      // **群から 1 件だけ外す。** 件数の下限（床）に掛かるので、群をまるごと消す形も
      // 一部だけ残す形も同じここで落ちる（どの添字を外しても下限を割るので 1 本で足りる）
      const short = runGateUnderShim(
        latestGateScriptName(),
        '',
        fullMarksReport(-1, { crossTenantAt: 0 }),
        benchMaterials(),
        printedMaterials(),
        coverageMaterial(),
      );
      expect(
        typeof short.status === 'number' && short.status !== 0,
        `越境テストが 1 件欠けたのに見逃した (終了コード ${String(short.status)})`,
      ).toBe(true);
    },
    testBudgetFor(1),
  );

  /**
   * カバレッジの合計（`coverage-summary.json`）として書かせる中身を組み立てる。
   *
   * **下限は正本から取る**（写しを持つと基準を変えたときにここだけが古くなる）。
   * `below` に指標名を渡すと、その 1 指標だけを下限未満にする。
   */
  function coverageMaterial(below?: string): string {
    // 4 指標ぶんの％（既定は下限ちょうど = 合格）
    const total = Object.fromEntries(
      ['statements', 'branches', 'functions', 'lines'].map((metric) => [
        metric,
        { pct: metric === below ? COVERAGE_MIN_PERCENT - 1 : COVERAGE_MIN_PERCENT },
      ]),
    );
    // json-summary レポータの形
    return JSON.stringify({ total });
  }

  it(
    '共有モジュールは import しただけでプロセスを終わらせない',
    () => {
      // 共有モジュールの一覧 (0 本なら導出が壊れている)
      const modules = sharedModuleNames();
      expect(modules.length, '共有モジュールが 1 つも無い').toBeGreaterThan(0);
      for (const name of modules) {
        // **子プロセスで import する。** ベンチ側の許可リストはベンチ 1 ファイルしか見ないので、
        // 共有モジュールの先頭に `if (process.env.VITEST === undefined) process.exit(0);` を
        // 1 行足すだけで、ベンチが何も出さずに exit 0 になった (実測で 773 件すべて緑)。
        // vitest の中では `VITEST` が立っているので、同じプロセスでは気付けない
        const stdout = importsWithoutExiting(join(SCRIPTS_DIR, 'lib', name));
        // import の先へ進めていること (途中で exit していれば印が出ない)
        expect(stdout, `${name} が import の時点でプロセスを終わらせる`).toContain('REACHED_END');
      }
    },
    // **子は共有モジュールの本数ぶん起こす**（1 本ぶんの予算だと、2 本目以降が張り付いたときに
    // vitest の締め切りが先に来て原因の分からない赤になる）。本数は導出から採る
    testBudgetFor(sharedModuleNames().length),
  );

  // 料金表のモデルの添字一覧 (件数を書き写さず正本から導く。0 件なら導出が壊れている)
  function pricedModelIndexes(): number[] {
    // 正本の JSON
    const models = (
      JSON.parse(
        readFileSync(join(ROOT, 'src', 'domain', 'pricing', 'vendor-prices.json'), 'utf8'),
      ) as { models: unknown[] }
    ).models;
    // 1 件も読めなければ fail-closed
    expect(models.length, '料金表のモデルを 1 つも読めない').toBeGreaterThan(0);
    return models.map((_model, index) => index);
  }

  /**
   * 出力を読んで判定するもの（E2E / Lighthouse）が標準出力へ出す中身を、npm スクリプト名ごとに
   * 組み立てる。**受け入れ基準を満たす内容**にするので、positive control が通る。
   *
   * **画面一覧・合格点・計測回数は正本から取る** — 写しを持つと、基準を変えたときに
   * この材料だけが古くなり「満点のつもりのレポートで赤くなる」形になる。
   */
  function printedMaterials(): Record<string, string> {
    // Playwright の JSON レポート（入れ子の suite の中に 5 画面ぶんの spec）
    const e2e = JSON.stringify({
      suites: [
        {
          title: 'screens.spec.ts',
          specs: [],
          suites: [
            {
              title: '主要 5 画面',
              specs: STEP5_SCREENS.map((screen) => ({
                title: `${SCREEN_TEST_PREFIX}${screen.title}`,
                ok: true,
                // **実行の記録まで本物と同じ形で入れる** — ゲートは `ok` ではなく
                // `tests[].status` を見る（skip も `ok: true` になるため）
                tests: [{ status: 'expected' }],
              })),
            },
          ],
        },
      ],
    });
    // Lighthouse の結果（全画面・全カテゴリが合格点）
    const lighthouse = JSON.stringify({
      measure: 'lighthouse',
      minScore: LIGHTHOUSE_MIN_SCORE,
      categories: LIGHTHOUSE_CATEGORIES,
      runs: LIGHTHOUSE_RUNS,
      pages: STEP5_SCREENS.map((screen) => ({
        page: screen.key,
        scores: Object.fromEntries(
          LIGHTHOUSE_CATEGORIES.map((category) => [category, LIGHTHOUSE_MIN_SCORE]),
        ),
      })),
    });
    // npm スクリプト名ごとに割り当てる
    return { 'test:e2e': e2e, lighthouse };
  }

  // ベンチが出す JSON の材料を npm スクリプト名ごとに組み立てる (ラベル・上限の写しを作らない)
  function benchMaterials(): Record<
    string,
    { label: string; valueField: string; limitField: string; limit: number }
  > {
    // ベンチ 1 本ごとに「どの npm が起動するか」と「どの項目を出すか」を対応づける
    return Object.fromEntries(
      Object.entries(BENCH_LABELS).map(([file, { label, valueField, limitField }]) => [
        benchNpmScriptOf(file),
        {
          label,
          valueField,
          limitField,
          limit: BENCH_LIMIT_BY_LABEL[label] ?? Number.NaN,
        },
      ]),
    );
  }

  // そのベンチを起動する npm スクリプト名を package.json から引く (ラベルの写しを作らない)
  const benchNpmScriptOf = (bench: string): string => {
    // package.json の scripts
    const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as Record<
      string,
      string
    >;
    // そのファイルを起動している bench: スクリプトを探す
    const found = Object.entries(scripts).find(
      ([name, command]) =>
        name.startsWith('bench:') &&
        new RegExp(`(?:^|\\s)scripts/${bench.replace('.', '\\.')}(?:\\s|$)`).test(command),
    );
    // 見つからなければ導出が壊れている (fail-closed)
    expect(found, `${bench} を起動する npm スクリプトが無い`).toBeDefined();
    return found?.[0] ?? '';
  };

  it('ベンチは専用 DB のガードをトップレベルで呼ぶ', () => {
    // ベンチは全テーブルを TRUNCATE するので、開発 DB を指していないかのガードを飛ばせない。
    // **「呼んでいるか」だけでは足りない** — 実測で `if (problem !== null &&
    // process.env.BENCH_STRICT_DB === '1') throw …` と条件を 1 つ足すだけで、呼び出しは
    // 残したままガードが実質外れた (705 件すべて緑)。判定と throw をまとめた関数を、
    // **トップレベルの式文として**、共有モジュールから取り込んだ名前で呼ぶことまで求める
    // 0 本なら空振りで緑になる (fail-closed)
    expect(benchScriptNames().length, 'ベンチが 1 本も無い').toBeGreaterThan(0);
    for (const bench of benchScriptNames()) {
      // そのベンチを起動する npm スクリプト名 (ガードの文言に出るラベルの正本)
      const script = benchNpmScriptOf(bench);
      expect(
        callsFunction(join(SCRIPTS_DIR, bench), 'requireContractDatabase', {
          atTopLevel: true,
          importedFrom: REQUIRED_BENCH_MODULE,
          // **ラベルを文字列リテラルで固定する** — 式を渡せると、その式がガードより先に走る
          literalArgument: { index: 0, value: script },
        }),
        `${bench} が requireContractDatabase('${script}') をトップレベルで呼んでいない`,
      ).toBe(true);
    }
  });
});
