// lint の指定そのものを固定する。
//
// ここが独立したファイルなのは、`tests/gate-scripts.test.ts` が「ゲートの判定」を見るファイルで、
// eslint を子プロセスで起こす検査は主題が違うため。
// **なぜ要るか**: `--max-warnings=0` は 2 つのガード (ゲートの `exitIfFailures` とベンチの捨て玉判定) を
// 支えている。呼び出しを消すと eslint は「未使用」と言うが、warning は既定では exit 0 に埋もれる
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 子プロセスの待ち時間の上限 (npx がレジストリを見に行って張り付くのを防ぐ)
const CHILD_TIMEOUT_MS = 180_000;
// warning を 1 つだけ起こす一時ファイルの名前 (pid を入れて並行実行でも衝突させない)
const PROBE_PREFIX = 'lint-warning-probe.';

describe('lint の指定そのもの', () => {
  // `package.json` の lint スクリプト
  const lintScript = (
    JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts.lint;

  it('eslint を --max-warnings=0 で走らせる', () => {
    // **この指定が 2 つのガードを支えている** — ベンチの判定と `exitIfFailures` は、
    // 呼び出しを消すと eslint が「未使用」と言うだけで、warning は既定では exit 0 に埋もれる。
    // 指定を外すと、その 2 つの変異がどちらも全件緑で通る状態に戻る (実測)
    // **より狭い代替**: 指定をやめて `@typescript-eslint/no-unused-vars` を 'error' に上げる形でも
    // 2 つのガードは支えられる。依存更新で warn ルールが増えて赤が常態化したらそちらへ切り替える
    expect(lintScript, 'lint から --max-warnings=0 を外さないこと').toMatch(/--max-warnings[= ]0/);
  });

  it(
    'warning だけでも `npm run lint` が非 0 終了する (綴りではなく挙動で確かめる)',
    () => {
      // 強制終了された前回の残骸を先に掃除する (残ると次の `npm run lint` が
      // 「誰も書いていないファイル」の未使用変数で落ちて、原因が分かりにくい)
      for (const name of readdirSync(join(process.cwd(), 'scripts'))) {
        if (name.startsWith(PROBE_PREFIX))
          rmSync(join(process.cwd(), 'scripts', name), { force: true });
      }
      // 未使用の変数だけを持つ一時ファイル (eslint の設定が当たる場所へ置く)
      const probePath = join(process.cwd(), 'scripts', `${PROBE_PREFIX}${process.pid}.mjs`);
      // 後始末を必ず行う
      try {
        // warning を 1 つだけ起こす
        writeFileSync(probePath, 'const unusedProbeValue = 1;\n');
        // 既定の eslint は warning を通す (前提の確認。ここが変わったらこの検査の意味が変わる)
        const lenient = spawnSync('npx', ['eslint', probePath], {
          encoding: 'utf8',
          timeout: CHILD_TIMEOUT_MS,
        });
        expect(lenient.status, '既定の eslint が warning で落ちている').toBe(0);
        // **プローブが本当に検査されていること。** lint の対象外 (ignores に入る等) だと
        // eslint は「File ignored」の warning を 1 件出すので、「既定は 0 / 指定付きは非 0」という
        // 関係だけは成立してしまい、検査は緑のまま何も測らなくなる (実測)
        expect(lenient.stdout, 'プローブが lint 対象から外れている').toContain(
          '@typescript-eslint/no-unused-vars',
        );
        expect(lenient.stdout, 'プローブが ignore されている').not.toContain('File ignored');
        // **`npm run lint` そのものが落ちること**を見る。eslint という道具ではなく
        // **ゲートが読むコマンド**を見ないと、`|| true` を足す / 対象パスを `src` へ狭める、
        // のどちらも素通りする (どちらも実測で全件緑だった)
        const viaNpm = spawnSync('npm', ['run', 'lint'], {
          encoding: 'utf8',
          timeout: CHILD_TIMEOUT_MS,
        });
        expect(viaNpm.status, 'npm run lint が warning を失敗にしていない').not.toBe(0);
      } finally {
        // 一時ファイルを消す
        rmSync(probePath, { force: true });
      }
      // eslint を 3 回起こすので既定の 5 秒では足りない (子プロセス側の上限は CHILD_TIMEOUT_MS)
    },
    CHILD_TIMEOUT_MS,
  );
});
