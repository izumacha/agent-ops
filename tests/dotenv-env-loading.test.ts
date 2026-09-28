// dotenv が `.env` の値を実際に `process.env` へ届けることを確かめる。
// **なぜこのテストが要るか**: この経路は CI の他のどのジョブでも値が確かめられない。`.env` は
// `.gitignore` と `.dockerignore` の両方で除外され、CI は `DATABASE_URL` をワークフローの `env:` で
// 直接渡すので、`import 'dotenv/config'` は毎回「存在しない `.env`」を読んで何も入れずに終わる。
// つまり **dotenv が値を入れなくなる退行は CI が緑のまま通す**（import 時に throw する退行なら
// `db:deploy` / `db:seed` が落ちるので、見えないのは「値の注入」だけ）。
// ここを機械で見張ることで、major を上げるたびに人が手で確かめる運用を置かずに済ませている。
// **機械化できたのは「値が届くこと」と「取り込み口が使えること」の 2 つだけ**で、
// import 時の副作用が増えていないかは引き続き人が見る（手順は `tests/gate-scripts.test.ts` の
// `ALLOWED_BENCH_PACKAGES` のコメントが持つ）。
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// `.env` を置いた一時ディレクトリを作り、そのパスを返す。
// **なぜ一時ディレクトリなのか**: dotenv は `.env` を `process.cwd()` から探すため、リポジトリ直下の
// `.env`（gitignore 済みで CI には存在しない）に依存させると、手元だけ通って CI では何も確かめない。
// **node_modules を symlink するのは、子に素の `import 'dotenv/config'` を書かせるため** —
// 絶対パスで直接読ませると exports map を迂回してしまい、**このリポジトリの 5 つの入口が実際に通る
// 経路（指定子の解決）を一度も試さないテストになる**。v18 が `./lib/cli-options` を落としたのと同じ
// 種類の変化（`"./config"` が `require` 条件だけになる等）は、迂回した書き方では緑のまま通る
function makeEnvDir(envFileContent: string | null): string {
  // 空のディレクトリを作る
  const dir = mkdtempSync(join(tmpdir(), 'agent-ops-dotenv-'));
  // 後始末の対象として覚えておく
  createdDirs.push(dir);
  // 素の指定子を解決できるよう、リポジトリの node_modules を指す symlink を張る
  symlinkSync(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
  // `.env` を置くよう指示されていれば書く（null なら「`.env` が無い」状況を作る）
  if (envFileContent !== null) writeFileSync(join(dir, '.env'), envFileContent);
  // 子の cwd に使うパスを返す
  return dir;
}

// 子プロセスで `.env` を読ませ、指定したキーが `process.env` にどう入ったかを返す。
// **なぜ子プロセスなのか**: `dotenv/config` は import した瞬間に現在のプロセスの `process.env` を
// 書き換えるので、同じプロセスで試すとテストランナー自身の環境を汚す（他のテストへ漏れる）。
// 作法は `tests/contract-database.test.ts` の `runGuardInChild` に合わせている
function loadDotenvInChild(
  envFileContent: string,
  keys: readonly string[],
  presetEnv: Readonly<Record<string, string>> = {},
): Record<string, string | null> {
  // `.env` を置いた作業ディレクトリを用意する
  const dir = makeEnvDir(envFileContent);

  // 子に実行させるコード: `.env` を読み込んでから、見たいキーの値を JSON で 1 行出す
  const code = [
    // **素の指定子で取り込む**（アプリの 5 つの入口とまったく同じ書き方にする）
    `import 'dotenv/config';`,
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

    // **固定する理由は運用の側**: ベンチも契約テストも
    // `DATABASE_URL='…_contract' npm run bench:usage` のように**コマンドラインで接続先を指定して**
    // 動かす（手順は README と各スクリプト冒頭にある）。上書きする版に変わると、手元に `.env` が
    // ある開発者ではこの指定が黙って無視され、指したつもりのない DB を指す。
    // **安全性の話ではない** — 専用 DB ガード（`scripts/lib/contract-database.mjs`）も
    // `createPrismaClient()` も同じ `process.env.DATABASE_URL` を `import 'dotenv/config'` の**後に**
    // 読むので両者がずれることはなく、`.env` が勝てばガードが開発 DB を見て止める（fail-closed）
    expect(env.PRESET_KEY, '.env が既存の環境変数を上書きしている').toBe('from-process-env');

    // **残る境界**: これは上流の既定の挙動を固定するものなので、こちら側のコードを変異させて
    // 赤くすることはできない。落ちるのは dotenv の側が変わったときだけで、「この族は閉じた」とは言えない
  });

  it('.env が無くても import が例外を投げない', () => {
    // `.env` を置かないディレクトリを用意する（**CI が毎回踏んでいるのはこの状況**）
    const dir = makeEnvDir(null);

    // 取り込むだけの子プロセスを走らせる（値は見ない）
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `import 'dotenv/config';`],
      {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env },
        timeout: 60_000,
      },
    );

    // 正常終了すること。`.env` が無い状態で throw する版に変わると、CI の `db:deploy` /
    // `db:seed` と本番コンテナの起動が同時に落ちる
    expect(result.status, `.env が無いと import が落ちる: ${result.stderr}`).toBe(0);
  });
});
