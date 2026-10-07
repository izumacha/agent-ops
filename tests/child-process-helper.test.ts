// Vitest のテスト API
import { describe, expect, it } from 'vitest';
// 子プロセスの型（合成した戻り値に型を付ける）
import type { SpawnSyncReturns } from 'node:child_process';
// 判定そのもの（この検査が主題にしている関数）
import { expectRan, interpretTrackedFiles } from './lib/child-process';

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
