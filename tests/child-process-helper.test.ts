// Vitest のテスト API
import { describe, expect, it } from 'vitest';
// 子プロセスの型（合成した戻り値に型を付ける）
import type { SpawnSyncReturns, spawnSync } from 'node:child_process';
// 判定そのもの（この検査が主題にしている関数）
import { expectRan, interpretTrackedFiles } from './lib/child-process';

// `expectRan` の**挙動**を合成した戻り値で固定する。
//
// **なぜ要るか**: この関数の値は「どの順で見るか」にある。時間切れは `error`（ETIMEDOUT）と
// `signal`（SIGTERM）の**両方**を立てるので（実測）、`error` を先に見ると時間切れが必ず
// 「起動できなかった」で落ち、**起きていない原因を名指し**する。ところが CI の子プロセスは
// 時間切れにならないので、**順を元へ戻しても `signal` の検査を消しても全件緑のまま**だった。
// このリポジトリが Stripe のガードで記録しているのと同じ「中身を空にしても緑」の形なので、
// 役割の要である順序を合成入力で押さえる。
describe('expectRan（子プロセスが走ったかの判定）', () => {
  // `spawnSync` の戻り値を、必要な 3 つのフィールドだけ合成する
  function result(parts: {
    error?: NodeJS.ErrnoException;
    signal?: NodeJS.Signals | null;
    status?: number | null;
  }): ReturnType<typeof spawnSync> {
    // 判定が読むのは error / signal / status の 3 つだけ
    return {
      error: parts.error,
      signal: parts.signal ?? null,
      status: parts.status ?? null,
      pid: 1,
      output: [],
      stdout: '',
      stderr: '',
    } as unknown as ReturnType<typeof spawnSync>;
  }

  it('正常に終わった結果は通す', () => {
    // 走って終了コードが取れている形
    expect(() => expectRan(result({ status: 1 }), 'probe')).not.toThrow();
  });

  it('時間切れは「打ち切られた」と言う（「起動できなかった」と取り違えない）', () => {
    // 時間切れの実際の形（error と signal の両方が立つ）
    const timedOut = result({
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
    const missing = result({
      error: Object.assign(new Error('spawnSync ENOENT'), { code: 'ENOENT' }),
    });
    // 起動の失敗として落ち、コードが文言に入ること
    expect(() => expectRan(missing, 'probe')).toThrow(/起動できなかった.*ENOENT/s);
  });

  it('終了コードが取れていない結果は落とす（null を素通りさせない）', () => {
    // 走ったように見えるが終了コードが無い形
    expect(() => expectRan(result({ status: null }), 'probe')).toThrow(/終了コードが取れていない/);
  });

  it('出力の上限超過を「時間切れ」と決め打ちしない（理由を出す）', () => {
    // ENOBUFS の実際の形（時間切れと**同じ** signal が立つ）
    const overflowed = result({
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
  // 必要なフィールドだけ合成する
  function gitResult(parts: {
    status?: number | null;
    stdout?: string;
    stderr?: string;
  }): SpawnSyncReturns<string> {
    // 判定が読むのは status / stdout / stderr と、expectRan の見る error / signal
    return {
      error: undefined,
      signal: null,
      status: parts.status ?? 0,
      stdout: parts.stdout ?? '',
      stderr: parts.stderr ?? '',
      pid: 1,
      output: [],
    } as unknown as SpawnSyncReturns<string>;
  }

  it('NUL 区切りの出力をパスの配列へ割る', () => {
    // 2 件＋末尾の空
    expect(interpretTrackedFiles(gitResult({ stdout: 'a.md\0b/c.md\0' }), '.')).toEqual([
      'a.md',
      'b/c.md',
    ]);
  });

  it('git が走って失敗したら、前提と git 自身の出力を名指しして落とす', () => {
    // 所有者違いなどで非 0 になった形
    const failed = gitResult({ status: 128, stderr: 'fatal: detected dubious ownership' });
    // 前提と stderr の両方が文言に出ること
    expect(() => interpretTrackedFiles(failed, '.')).toThrow(/作業ツリーを前提/);
    expect(() => interpretTrackedFiles(failed, '.')).toThrow(/dubious ownership/);
  });

  it('exit 0 で出力が空なら空配列を返す（ここでは落とさない）', () => {
    // 未追跡のディレクトリを指したときの形。**落とすのは呼び出し側の fail-closed の仕事**
    expect(interpretTrackedFiles(gitResult({ stdout: '' }), 'docs')).toEqual([]);
  });
});
