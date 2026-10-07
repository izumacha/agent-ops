// Vitest のテスト API
import { describe, expect, it } from 'vitest';
// 子プロセスの型（合成した戻り値に型を付ける）
import type { spawnSync } from 'node:child_process';
// 判定そのもの（この検査が主題にしている関数）
import { expectRan } from './lib/child-process';

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
    // 打ち切りとして落ちること（文言まで固定する — ここが順序の効き目）
    expect(() => expectRan(timedOut, 'probe')).toThrow(/打ち切られた/);
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
});
