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
// **残る境界**: `scripts/gate-step1.mjs` から `exitIfFailures(...)` の呼び出し行ごと消す変異は
// 署名からは見分けられない (規約とレビューで守る。判定の塊が丸ごと消える差分なので目には付く)
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateStep1Report, missingMatrixCases } from '../scripts/lib/gate-report.mjs';

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
