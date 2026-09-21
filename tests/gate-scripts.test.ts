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
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  benchOutputProblems,
  evaluateStep1Report,
  evaluateStep2Report,
  missingMatrixCases,
  missingPriceCases,
} from '../scripts/lib/gate-report.mjs';
import { PRICE_TEST_PREFIX } from '../scripts/lib/step2-criteria.mjs';
import {
  MIN_MEASURED_REQUESTS,
  WARMUP_MAX_MS,
  addedLatencyProblem,
  aggregateLatencyProblem,
  benchCriteriaFields,
  benchCriteriaJudges,
  intFromEnvValue,
  isBenchLabel,
  judgeBenchPayload,
  measuredRequestsProblem,
  non2xxProblem,
  runBench,
  warmupCountProblem,
  warmupLatencyProblem,
} from '../scripts/lib/bench-criteria.mjs';
import {
  PROXY_ADDED_LATENCY_P95_MAX_MS,
  USAGE_AGGREGATE_MAX_MS,
} from '../scripts/lib/step2-criteria.mjs';
import {
  SCRIPTS_DIR,
  callsFunction,
  describedNamesWithTests,
  gateScriptNames,
  importSharedModule,
  foreignModuleSpecifiers,
  processUses,
  topLevelCallNames,
  topLevelInitializerEffects,
  topLevelStatementKinds,
  importedSharedNames,
  reachableCallNames,
} from './lib/script-files';

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
    timeout: 120_000,
  });
  // 終了コードと標準出力
  return { status: result.status, stdout: result.stdout };
}

// リポジトリのルート
const ROOT = process.cwd();
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

describe('runSteps', () => {
  it('ステップが失敗したらその場で非 0 終了する (後続を実行しない)', () => {
    // 存在しない npm script を 1 つ実行させ、そのあとに到達しないことを見る
    const result = runInChild([
      `runSteps('テスト', [{ name: '失敗するステップ', args: ['run', '__agent_ops_missing_script__'] }]);`,
    ]);
    // 非 0 終了であること (process.exit を消すと 0 で終わり、続きまで到達する)
    expect(result.status, 'ゲートが失敗を素通りしている').not.toBe(0);
    // 後続へ進んでいないこと
    expect(result.stdout).not.toContain('REACHED_END');
  });
});

describe('exitIfFailures', () => {
  it('満たしていない基準があれば非 0 終了する (判定結果を捨てない)', () => {
    // 理由を 1 つ渡す
    const result = runInChild([`exitIfFailures('テスト', ['件数が足りません']);`]);
    // 非 0 終了で、続きへ進んでいないこと。**ここが実測で一番危なかった** —
    // この 1 行を消すと、失敗の理由を表示したうえで「ゲート緑」と出て exit 0 になった
    expect(result.status, 'ゲートが判定結果を捨てている').not.toBe(0);
    expect(result.stdout).not.toContain('REACHED_END');
  });

  it('基準を満たしていれば何もしない (正常時に落とさない)', () => {
    // 失敗が無いときは処理を続ける
    const result = runInChild([`exitIfFailures('テスト', []);`]);
    // 正常終了し、続きまで到達すること
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('REACHED_END');
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
};

describe('benchOutputProblems', () => {
  // ベンチが実際に出す形 (npm 自身の行が前後に混ざる)
  const stdout = ['', '> agent-ops@0.1.0 bench:usage', '', '%s', ''].join('\n');
  // 基準を満たした 1 回ぶんの出力
  const ok = stdout.replace(
    '%s',
    JSON.stringify({ bench: 'usage-aggregate', slowestMs: 13, limitMs: 1000, passed: true }),
  );
  // 判定に渡す共通の引数
  const fields = { valueField: 'slowestMs', limitField: 'limitMs' } as const;

  it('基準を満たした出力なら問題なし', () => {
    // 終了コード 0・ラベル一致・passed: true・実測値が上限以内
    expect(
      benchOutputProblems({ label: 'usage-aggregate', status: 0, stdout: ok, ...fields }),
    ).toEqual([]);
  });

  it('終了コードが 0 でなければ落とす', () => {
    // ベンチ自身が理由を出しているので、ここでは事実だけを残す
    expect(
      benchOutputProblems({ label: 'usage-aggregate', status: 1, stdout: ok, ...fields }),
    ).toHaveLength(1);
  });

  it('結果の JSON が無ければ落とす', () => {
    // **これがゲートの要点** — 「何も出さずに exit 0」を緑にしない (fail-closed)
    expect(
      benchOutputProblems({ label: 'usage-aggregate', status: 0, stdout: '', ...fields }),
    ).toEqual(['ベンチ usage-aggregate が結果の JSON を出していません']);
  });

  it('別のベンチの結果なら落とす', () => {
    // ラベルの取り違え (片方のベンチを 2 回流す形) を落とす
    const other = stdout.replace(
      '%s',
      JSON.stringify({ bench: 'proxy-latency', slowestMs: 13, limitMs: 1000, passed: true }),
    );
    expect(
      benchOutputProblems({ label: 'usage-aggregate', status: 0, stdout: other, ...fields }).length,
    ).toBeGreaterThan(0);
  });

  it('passed が true でなければ落とす', () => {
    // ベンチ側の判定をそのまま尊重する
    const failed = ok.replace('"passed":true', '"passed":false');
    expect(
      benchOutputProblems({ label: 'usage-aggregate', status: 0, stdout: failed, ...fields }),
    ).toContain('ベンチ usage-aggregate が受け入れ基準を満たしていません');
  });

  it('passed が true でも実測値が上限を超えていれば落とす', () => {
    // **`passed` の写しにしない** — passed だけを見ると「true を出すだけ」の変異が素通りする
    const lying = stdout.replace(
      '%s',
      JSON.stringify({ bench: 'usage-aggregate', slowestMs: 1001, limitMs: 1000, passed: true }),
    );
    expect(
      benchOutputProblems({ label: 'usage-aggregate', status: 0, stdout: lying, ...fields }),
    ).toContain('ベンチ usage-aggregate の slowestMs が上限を超えています (1001 > 1000)');
  });

  it('実測値か上限が数値でなければ落とす', () => {
    // 項目を消すだけで比較を飛ばせないようにする (fail-closed)
    const missing = stdout.replace(
      '%s',
      JSON.stringify({ bench: 'usage-aggregate', limitMs: 1000, passed: true }),
    );
    expect(
      benchOutputProblems({ label: 'usage-aggregate', status: 0, stdout: missing, ...fields }),
    ).toContain('ベンチ usage-aggregate の結果に数値の slowestMs / limitMs がありません');
  });

  it('壊れた JSON の行があっても最後の正しい結果を読む', () => {
    // 進捗の出力に `{` で始まる行が混ざっても落ちない
    const noisy = ['{ これは JSON ではない', ok].join('\n');
    expect(
      benchOutputProblems({ label: 'usage-aggregate', status: 0, stdout: noisy, ...fields }),
    ).toEqual([]);
  });
});

describe('isBenchLabel', () => {
  it('表にあるラベルだけを認める', () => {
    // 実在するラベル
    expect(isBenchLabel('usage-aggregate')).toBe(true);
    // 打ち間違い・プロトタイプ由来の名前は認めない (fail-closed)
    expect(isBenchLabel('usage_aggregate')).toBe(false);
    expect(isBenchLabel('toString')).toBe(false);
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
  const BENCH_LABELS: Readonly<Record<string, string>> = {
    'bench-proxy.ts': 'proxy-latency',
    'bench-usage-aggregate.ts': 'usage-aggregate',
  };

  // ベンチが `process` に触れてよい形。**すべて純粋な読み取りだけ**で、
  // ここに無い形 (`process.exit` / 要素アクセス / 別名束縛 / `process.on('exit', …)` /
  // `Object.defineProperty(process, …)`) は「許可リストに無い」という 1 つの理由で落ちる
  const ALLOWED_PROCESS_USES = new Set(['process.env', 'process.cwd', 'process.execPath']);

  // ベンチのトップレベルの変数初期化子で呼んでよいもの。**定数を組み立てるだけの純粋な呼び出し**に限る。
  // **エントリを足す差分は、その呼び出しが副作用を持たないかをレビューで必ず確認する**
  // (この表が緩むと、専用 DB のガードより前に何でも走らせられる)
  const ALLOWED_TOP_LEVEL_INITIALIZER_CALLS = new Set([
    'intFromEnv',
    'join',
    'process.cwd',
    'JSON.stringify',
  ]);

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
    // **ラベルは共有モジュール側の基準の表と過不足なく一致すること** —
    // 片方にだけ足すと「誰も掛けない基準」か「基準の無いベンチ」が黙って生まれる
    const labels = Object.values(BENCH_LABELS);
    for (const label of labels)
      expect(isBenchLabel(label), `${label} は bench-criteria の基準に無い`).toBe(true);
    // 重複したラベルを許すと 2 本が同じ基準を指して片方の基準が消える
    expect(new Set(labels).size, 'ラベルが重複している').toBe(labels.length);
    for (const [bench, label] of Object.entries(BENCH_LABELS)) {
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
      for (const effect of topLevelInitializerEffects(path))
        expect(
          ALLOWED_TOP_LEVEL_INITIALIZER_CALLS.has(effect),
          `${bench} のトップレベルの初期化子が ${effect} を起こす`,
        ).toBe(true);
      // 相対 import の先は共有モジュール (scripts/lib) かアプリ本体 (src) だけ。
      // **ここも視界の外だった** — 実測で `scripts/preflight.mjs` に `process.exit(0)` を置いて
      // `import './preflight.mjs';` を 1 行足すと、全件緑のまま出力ゼロで exit 0 になった
      // (ESM は import した側のどのトップレベル文よりも先に評価される)
      for (const specifier of foreignModuleSpecifiers(path)) {
        // 相対パスでなければ node: か npm パッケージ (副作用は package.json 側の関心事)
        if (!specifier.startsWith('.')) continue;
        // 解決先がアプリ本体の中なら許す (ベンチは本番のアダプタと結線を使う)
        expect(
          resolve(SCRIPTS_DIR, specifier).startsWith(join(SCRIPTS_DIR, '..', 'src') + sep),
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

  it('bench-criteria の判定はすべてどれかの基準で使われている', async () => {
    // 判定の名前は**モジュールの export から導く** (一覧を手書きすると、足した判定が黙って外れる)
    const criteria = await importSharedModule('bench-criteria.mjs');
    // 表のどれかで実際に使われている判定 (関数の同一性で持つ)
    const used = benchCriteriaJudges();
    // 1 つも読めなければ導出が壊れている (fail-closed)
    expect(used.size, '基準に使われている判定が 0 件').toBeGreaterThan(0);
    // 判定の命名規約 (`*Problem`) で export を絞り、すべてが使われていることを求める。
    // **これが無いと、基準を表から削り挙動の表の行も同時に削るだけで全件緑になり、
    // 痕跡はテスト件数の減少だけだった** (実測)。外すには export ごと消すしかなくする
    const judgements = Object.entries(criteria).filter(
      (entry): entry is [string, (...args: never[]) => unknown] =>
        typeof entry[1] === 'function' && entry[0].endsWith('Problem'),
    );
    // 1 つも無ければ導出が壊れている (fail-closed)
    expect(judgements.length, '判定を 1 つも読めない').toBeGreaterThan(0);
    for (const [name, judge] of judgements)
      expect(used.has(judge), `${name} はどの基準にも使われていない`).toBe(true);
  });

  it('ベンチは専用 DB のガードをトップレベルで呼ぶ', () => {
    // ベンチは全テーブルを TRUNCATE するので、開発 DB を指していないかのガードを飛ばせない。
    // **「呼んでいるか」だけでは足りない** — 実測で `if (problem !== null &&
    // process.env.BENCH_STRICT_DB === '1') throw …` と条件を 1 つ足すだけで、呼び出しは
    // 残したままガードが実質外れた (705 件すべて緑)。判定と throw をまとめた関数を、
    // **トップレベルの式文として**、共有モジュールから取り込んだ名前で呼ぶことまで求める
    // 0 本なら空振りで緑になる (fail-closed)
    expect(benchScriptNames().length, 'ベンチが 1 本も無い').toBeGreaterThan(0);
    for (const bench of benchScriptNames()) {
      expect(
        callsFunction(join(SCRIPTS_DIR, bench), 'requireContractDatabase', {
          atTopLevel: true,
          importedFrom: REQUIRED_BENCH_MODULE,
        }),
        `${bench} が専用 DB のガードをトップレベルで呼んでいない`,
      ).toBe(true);
    }
  });
});
