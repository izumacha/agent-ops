// Vitest のテスト API
import { describe, expect, it } from 'vitest';
// 子プロセスの型（合成した戻り値に型を付ける）
import type { SpawnSyncReturns } from 'node:child_process';
// 判定そのもの（この検査が主題にしている関数）
import {
  CHILD_TIMEOUT_MS,
  expectRan,
  interpretRepoRoot,
  interpretTrackedFiles,
  MEASURED_WIDEST_CHILD_COUNT,
  MEASURED_WIDEST_RUNTIME_MS,
  testBudgetFor,
} from './lib/child-process';

// `spawnSync` の戻り値を合成する。**1 つだけ持つ** — 2 つに分けていたときは
// `status` の既定が `?? null` と `?? 0` で食い違い、**`status: null` を渡しても 0 になって
// 「終了コードが取れていない」の分岐に届かなかった**（実測。その分岐はこのファイルが
// 守るために在るもの）。既定は `null`（`spawnSync` が ENOENT と時間切れで返す値）にして、
// 正常終了を見たいときだけ呼ぶ側が `status: 0` を明示する
function fakeResult(parts: {
  error?: NodeJS.ErrnoException;
  signal?: NodeJS.Signals | null;
  status?: number | null;
  stdout?: string;
  stderr?: string;
}): SpawnSyncReturns<string> {
  // 判定が読むのは error / signal / status / stdout / stderr
  return {
    error: parts.error,
    signal: parts.signal ?? null,
    status: parts.status ?? null,
    stdout: parts.stdout ?? '',
    stderr: parts.stderr ?? '',
    pid: 1,
    output: [],
  } as unknown as SpawnSyncReturns<string>;
}

// `expectRan` の**挙動**を合成した戻り値で固定する。
//
// **なぜ要るか**: この関数の値は「どの順で見るか」にある。時間切れは `error`（ETIMEDOUT）と
// `signal`（SIGTERM）の**両方**を立てるので（実測）、`error` を先に見ると時間切れが必ず
// 「起動できなかった」で落ち、**起きていない原因を名指し**する。ところが CI の子プロセスは
// 時間切れにならないので、**順を元へ戻しても `signal` の検査を消しても全件緑のまま**だった。
// このリポジトリが Stripe のガードで記録しているのと同じ「中身を空にしても緑」の形なので、
// 役割の要である順序を合成入力で押さえる。
describe('expectRan（子プロセスが走ったかの判定）', () => {
  it('正常に終わった結果は通す', () => {
    // 走って終了コードが取れている形
    expect(() => expectRan(fakeResult({ status: 1 }), 'probe')).not.toThrow();
  });

  it('時間切れは「完走しなかった」と言い、理由も出す（「起動できなかった」と取り違えない）', () => {
    // 時間切れの実際の形（error と signal の両方が立つ）
    const timedOut = fakeResult({
      error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      signal: 'SIGTERM',
    });
    // 完走しなかった側で落ち、理由（errno）も出ること（ここが順序の効き目）
    expect(() => expectRan(timedOut, 'probe')).toThrow(/完走しなかった.*ETIMEDOUT/s);
    // **起動の失敗として落ちないこと**（順を戻すとこちらになる）
    expect(() => expectRan(timedOut, 'probe')).not.toThrow(/起動できなかった/);
  });

  it('実行ファイルが無い場合は「起動できなかった」と言い、理由のコードも出す', () => {
    // ENOENT の実際の形（error だけが立つ）
    const missing = fakeResult({
      error: Object.assign(new Error('spawnSync ENOENT'), { code: 'ENOENT' }),
    });
    // 起動の失敗として落ち、コードが文言に入ること
    expect(() => expectRan(missing, 'probe')).toThrow(/起動できなかった.*ENOENT/s);
  });

  it('終了コードが取れていない結果は落とす（null を素通りさせない）', () => {
    // 走ったように見えるが終了コードが無い形
    expect(() => expectRan(fakeResult({ status: null }), 'probe')).toThrow(
      /終了コードが取れていない/,
    );
  });

  it('出力の上限超過を「時間切れ」と決め打ちしない（理由を出す）', () => {
    // ENOBUFS の実際の形（時間切れと**同じ** signal が立つ）
    const overflowed = fakeResult({
      error: Object.assign(new Error('spawnSync ENOBUFS'), { code: 'ENOBUFS' }),
      signal: 'SIGTERM',
    });
    // 理由が文言に出ること（signal だけを見た文言は「時間切れ」と言ってしまう）
    expect(() => expectRan(overflowed, 'probe')).toThrow(/完走しなかった.*ENOBUFS/s);
  });
});

// `git ls-files` の結果の読み方を合成入力で固定する。
//
// **なぜ要るか**: 実測で、`status` を見る assertion を丸ごと消しても `npm test` は
// 1,862 件緑のまま（件数も変わらない）だった — git が走って失敗する状況が CI に無いため。
// `dubious ownership` / index の破損 / 作業ツリーでない、を名指しする分岐がここにある。
describe('interpretTrackedFiles（git ls-files の結果の読み方）', () => {
  it('NUL 区切りの出力をパスの配列へ割る', () => {
    // 2 件＋末尾の空
    expect(interpretTrackedFiles(fakeResult({ status: 0, stdout: 'a.md\0b/c.md\0' }), '.')).toEqual(
      ['a.md', 'b/c.md'],
    );
  });

  it('git が走って失敗したら、前提と git 自身の出力を名指しして落とす', () => {
    // 所有者違いなどで非 0 になった形
    const failed = fakeResult({ status: 128, stderr: 'fatal: detected dubious ownership' });
    // 前提と stderr の両方が文言に出ること
    expect(() => interpretTrackedFiles(failed, '.')).toThrow(/作業ツリーを前提/);
    expect(() => interpretTrackedFiles(failed, '.')).toThrow(/dubious ownership/);
  });

  it('status が null なら落とす（終了コードが取れていない）', () => {
    // 起動の失敗・時間切れのあとの形（既定が 0 だと、この検査は書いても届かなかった）
    expect(() => interpretTrackedFiles(fakeResult({ status: null }), '.')).toThrow(
      /終了コードが取れていない/,
    );
  });

  it('exit 0 で出力が空なら空配列を返す（ここでは落とさない）', () => {
    // 未追跡のディレクトリを指したときの形。**落とすのは呼び出し側の fail-closed の仕事**
    expect(interpretTrackedFiles(fakeResult({ status: 0, stdout: '' }), 'docs')).toEqual([]);
  });
});

// `interpretRepoRoot`（`git rev-parse --show-toplevel` の結果の読み方）の**挙動**を固定する。
//
// **なぜ要るか**: `expectRan` とまったく同じ「どの順で見るか」の問題がここにもあり、
// 実際 PR #26 の時点では**この関数だけが `error` を先に見ていた**（時間切れが
// 「起動できなかった」で落ちる）。本物の時間切れは CI では起きないので、
// 順を戻しても・分岐を消しても全件緑のままになる。合成入力でしか押さえられない。
describe('interpretRepoRoot（リポジトリの根の読み方）', () => {
  it('正常に終わった結果は末尾の改行を落として返す', () => {
    // git が根を出して 0 で終わった形
    expect(interpretRepoRoot(fakeResult({ status: 0, stdout: '/repo/root\n' }))).toBe('/repo/root');
  });

  it('時間切れは「完走しなかった」と言い、理由も出す（「起動できなかった」と取り違えない）', () => {
    // 時間切れの実際の形（error と signal の両方が立つ）
    const timedOut = fakeResult({
      error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      signal: 'SIGTERM',
    });
    // 完走しなかった側で落ち、シグナルと errno の両方が出ること（ここが順序の効き目）
    expect(() => interpretRepoRoot(timedOut)).toThrow(/完走しなかった.*SIGTERM.*ETIMEDOUT/s);
    // **起動の失敗として落ちないこと**（順を戻すとこちらになる）
    expect(() => interpretRepoRoot(timedOut)).not.toThrow(/起動できなかった/);
  });

  it('出力の上限超過（ENOBUFS）も「完走しなかった」側で、時間切れと決め打ちしない', () => {
    // ENOBUFS も signal: SIGTERM を立てる（実測）
    const tooMuch = fakeResult({
      error: Object.assign(new Error('spawnSync ENOBUFS'), { code: 'ENOBUFS' }),
      signal: 'SIGTERM',
    });
    // 理由が ENOBUFS として出ること（「時間切れ」と書かない）
    expect(() => interpretRepoRoot(tooMuch)).toThrow(/完走しなかった.*ENOBUFS/s);
  });

  it('git が無い場合は「起動できなかった」と言い、理由のコードも出す', () => {
    // ENOENT の実際の形（error だけが立つ）
    const missing = fakeResult({
      error: Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' }),
    });
    // 起動の失敗として落ち、errno も出ること
    expect(() => interpretRepoRoot(missing)).toThrow(/起動できなかった \(ENOENT\)/);
  });

  it('走って失敗した場合は前提と git の出力を見せる', () => {
    // 作業ツリーでないときの形
    const notRepo = fakeResult({ status: 128, stderr: 'fatal: not a git repository\n' });
    // 前提（git の作業ツリー）を名指しし、git 自身の出力も出すこと
    expect(() => interpretRepoRoot(notRepo)).toThrow(/git の作業ツリーを前提/);
    expect(() => interpretRepoRoot(notRepo)).toThrow(/not a git repository/);
  });

  it('終了コードが取れていない結果（status: null）を成功として扱わない', () => {
    // error も signal も無いのに status が null、という形（`?? 0` で畳む退行で起こる）
    expect(() => interpretRepoRoot(fakeResult({ stdout: '/repo/root' }))).toThrow(/が失敗した/);
  });
});

// `testBudgetFor`（子の本数から `it()` の締め切りを出す）の**挙動**を固定する。
//
// **なぜ要るか**: この関数が守っているのは「vitest の締め切りが子の上限より先に来ない」
// ことだけで、短くしても**張り付かない限り誰も気付かない**（原因の分からない
// 「Test timed out in …」になるのは退行の後に実際に何かが張り付いたときだけ）。
//
// **ここで落とせるもの**: 張り付いた 1 本ぶんを落とす／本数ぶんを定数へ畳む／
// 本数に比例しない形にする／本数ぶん子の上限を積む（CI のジョブの上限を超える）／
// **1 本ぶんの見積もりを実測の走行時間より小さくする**（下限は `MEASURED_WIDEST_*` から引く）。
//
// **ここで落とせないもの**（どれも規約とレビューで守る）:
// (a) 後片付けの余裕（`TEST_TIMEOUT_MARGIN_MS`）を 0 にする退行 — 実測の根拠を持たない
//     判断値で、0 でも「張り付いた 1 本 ＋ 残りの走行時間」は覆えているので下限を置いていない。
// (b) 見積もりが遅い CI ランナーで足りているか — 締めると遅い機械で原因の分からない赤になる。
// (c) 呼び出し側が渡す本数が実際の本数と合っているか（`tests/gate-scripts.test.ts` の
//     締め切りの検査も上側しか見ない）。
describe('testBudgetFor（子プロセスを起こすテストの締め切り）', () => {
  it('どの本数でも、張り付いた子 1 本ぶんの上限を必ず上回る', () => {
    // 1 本から 20 本まで、子側の上限より必ず長いこと。
    // **ここが買っているもの**: 子が張り付いたとき、子側の時間切れが先に効いて
    // `expectRan` の「完走しなかった (…: ETIMEDOUT)」が出る（vitest の
    // 「Test timed out in …」で原因が消えない）
    for (let children = 1; children <= 20; children += 1)
      expect(testBudgetFor(children)).toBeGreaterThan(CHILD_TIMEOUT_MS);
  });

  it('本数に応じて増える（正常に走る子の時間を見込まない退行を落とす）', () => {
    // 本数が増えれば締め切りも伸びること（定数へ畳む退行だと、本数の多いテストで
    // 正常な子の走行時間に押し出されて原因の分からない赤になる）
    expect(testBudgetFor(2)).toBeGreaterThan(testBudgetFor(1));
    // 増え方が本数に比例していること（1 本ぶんの増分が一定）
    expect(testBudgetFor(3) - testBudgetFor(2)).toBe(testBudgetFor(2) - testBudgetFor(1));
  });

  it('1 本ぶんの増分が、実測した 1 本の走行時間を下回らない', () => {
    // **1 本ぶんの見積もりを潰す退行を落とす。** 比例と「1 本ぶんの上限を上回る」だけを
    // 見ていた版では、見積もりを 1 ミリ秒にしても全件緑だった（実測）— 比は一定のままで、
    // 180 秒の側が大きいので「上回る」も成り立つ。
    // 下限は**この機械での実測**（いちばん子を多く起こすテストの所要時間 ÷ その本数）から引く。
    // 遅い CI ランナー向けの見積もりとは別の、独立した手がかり
    const measuredPerChild = MEASURED_WIDEST_RUNTIME_MS / MEASURED_WIDEST_CHILD_COUNT;
    // 1 本増えたときの増分（＝1 本ぶんの見積もり）
    const perChild = testBudgetFor(2) - testBudgetFor(1);
    // 実測した 1 本ぶんすら覆えない値にしない
    expect(perChild, '1 本ぶんの見積もりが実測の走行時間を下回っている').toBeGreaterThanOrEqual(
      measuredPerChild,
    );
  });

  it('本数 × 子の上限では積まない（CI のジョブの上限を超えるため）', () => {
    // **本数ぶん積む形への退行を落とす。** 17 本のテストがあるので、その形だと
    // 51.5 分になり CI の `gate` ジョブの `timeout-minutes: 45` を超える
    // （ジョブが先に死ぬので、この締め切りが買っている assertion が一度も出ない）。
    // 実際の本数との突き合わせは `tests/gate-scripts.test.ts` が ci.yml から導いて行う
    expect(testBudgetFor(17)).toBeLessThan(17 * CHILD_TIMEOUT_MS);
  });
});
