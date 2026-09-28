// dotenv が `.env` の値を実際に `process.env` へ届けることを確かめる。
// **なぜこのテストが要るか**: この経路は CI の他のどのジョブでも値が確かめられない。`.env` は
// `.gitignore` と `.dockerignore` の両方で除外され、CI は `DATABASE_URL` をワークフローの `env:` で
// 直接渡すので、`import 'dotenv/config'` は毎回「存在しない `.env`」を読んで何も入れずに終わる。
// つまり **dotenv が値を入れなくなる退行は CI が緑のまま通す**（import 時に throw する退行なら
// `db:deploy` / `db:seed` が落ちるので、見えないのは「値の注入」だけ）。
// ここを機械で見張ることで、major を上げるたびに人が手で確かめる運用を置かずに済ませている。
// **機械化できたのは「値が届くこと」と「取り込み口が残っていること」の 2 つだけ**で、
// import 時の副作用が増えていないかは `tests/gate-scripts.test.ts` の `ALLOWED_BENCH_PACKAGES` の
// コメント（18 での実測）を頼りに人が見る。詳しい線引きは `CLAUDE.md` §3 の dotenv の項が持つ。
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ESM のテストファイルには `require` が無いので、`import.meta.url` を起点に作る
const require = createRequire(import.meta.url);

// 一時ディレクトリをまとめて消せるように、作ったものを覚えておく
const createdDirs: string[] = [];

// テストが終わったら作った一時ディレクトリを片付ける
afterAll(() => {
  // 作った順に 1 つずつ削除する
  for (const dir of createdDirs) {
    // 中身ごと消す（存在しなくてもエラーにしない）
    rmSync(dir, { recursive: true, force: true });
  }
});

// 子プロセスで `.env` を読ませ、指定したキーが `process.env` にどう入ったかを返す。
// **なぜ子プロセスなのか**: `dotenv/config` は import した瞬間に現在のプロセスの `process.env` を
// 書き換えるので、同じプロセスで試すとテストランナー自身の環境を汚す（他のテストへ漏れる）。
// **なぜ一時ディレクトリなのか**: dotenv は `.env` を `process.cwd()` から探すため、リポジトリ直下の
// `.env`（gitignore 済みで CI には存在しない）に依存させると、手元だけ通って CI では何も確かめない。
function loadDotenvInChild(
  envFileContent: string,
  keys: readonly string[],
  presetEnv: Readonly<Record<string, string>> = {},
): Record<string, string | null> {
  // `.env` を置くための空のディレクトリを作る
  const dir = mkdtempSync(join(tmpdir(), 'agent-ops-dotenv-'));
  // 後始末の対象として覚えておく
  createdDirs.push(dir);
  // 読ませたい内容をそのディレクトリの `.env` として書く
  writeFileSync(join(dir, '.env'), envFileContent);

  // **取り込み口の解決は親で行う**。子の cwd はリポジトリ外なので、子の中で素朴に
  // `import 'dotenv/config'` と書いても node_modules までたどり着けない
  // （`tests/contract-database.test.ts` がガードのパスを親で組み立てているのと同じ理由）
  const configModuleUrl = pathToFileURL(require.resolve('dotenv/config')).href;

  // 子に実行させるコード: `.env` を読み込んでから、見たいキーの値を JSON で 1 行出す
  const code = [
    // dotenv の取り込み口を読む（これが `process.env` を書き換える）
    `await import(${JSON.stringify(configModuleUrl)});`,
    // 見たいキーだけを拾う（未定義は null にして「入らなかった」ことを区別できるようにする）
    `const picked = Object.fromEntries(${JSON.stringify(keys)}.map((k) => [k, process.env[k] ?? null]));`,
    // 親が解析できるよう JSON で出力する
    `console.log(JSON.stringify(picked));`,
  ].join('\n');

  // 一時ディレクトリを cwd にして実行する（dotenv がそこの `.env` を読む）
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: dir,
    encoding: 'utf8',
    // 先に入れておきたい環境変数があれば重ねる（「上書きしない」性質を見るために使う）
    env: { ...process.env, ...presetEnv },
    timeout: 60_000,
  });

  // 起動そのものに失敗していたら、値を読む前に理由を出して落とす（fail-closed）
  expect(result.status, `子プロセスが失敗した: ${result.stderr}`).toBe(0);
  // 出力された JSON を解析して返す
  return JSON.parse(result.stdout.trim()) as Record<string, string | null>;
}

describe('dotenv が .env の値を process.env へ届ける', () => {
  it('引用符つき・素のどちらの書き方でも値が入る', () => {
    // このリポジトリの `.env` と同じ書き方を両方入れる
    // （`DATABASE_URL="postgresql://..."` は引用符つき、`PLATFORM_ADMIN_TOKEN=...` は素）
    const env = loadDotenvInChild(
      [
        'QUOTED_VALUE="postgresql://user:pass@localhost:5432/db?schema=app"',
        'BARE_VALUE=plain-token',
      ].join('\n'),
      ['QUOTED_VALUE', 'BARE_VALUE'],
    );

    // 引用符が剥がれた値が届いていること
    expect(env.QUOTED_VALUE, '引用符つきの値が届いていない').toBe(
      'postgresql://user:pass@localhost:5432/db?schema=app',
    );
    // 素の値も届いていること
    expect(env.BARE_VALUE, '素の値が届いていない').toBe('plain-token');
  });

  it('既に設定済みの環境変数は上書きしない', () => {
    // 先に入っている値と、`.env` 側の別の値を用意する
    const env = loadDotenvInChild('PRESET_KEY=from-dotenv-file', ['PRESET_KEY'], {
      PRESET_KEY: 'from-process-env',
    });

    // **この性質にこのリポジトリは実際に依存している**: CI はワークフローの `env:` で
    // `DATABASE_URL` を渡し、ベンチの専用 DB ガード（`scripts/lib/contract-database.mjs`）は
    // その値が勝つ前提で「接尾辞が `_contract` か」を見ている。上書きする版に変わると、
    // 開発 DB を指した `.env` がガードを迂回させうる
    expect(env.PRESET_KEY, '.env が既存の環境変数を上書きしている').toBe('from-process-env');

    // **残る境界**: これは上流の既定の挙動を固定するものなので、こちら側のコードを変異させて
    // 赤くすることはできない。落ちるのは dotenv の側が変わったときだけで、「この族は閉じた」とは言えない
  });

  it('このリポジトリが使う取り込み口 dotenv/config が解決できる', () => {
    // v18 は exports から `./lib/cli-options` と `./lib/env-options` を落とした。
    // 同じ種類の変化（このリポジトリが使う `./config` が消える）をここで捕まえる。
    // 解決できなければ `require.resolve` が throw するので、呼べること自体が検査になる
    expect(() => require.resolve('dotenv/config'), 'dotenv/config が解決できない').not.toThrow();
  });
});
