// テストから子プロセスを起こす共通部分。
//
// **ここが「起動できなかった」と「走って失敗した」を分ける判定の置き場所。**
// 挙動は `tests/child-process-helper.test.ts` が合成入力で固定する（順序を戻しても CI では
// 緑のままなので、テストで押さえないと役割が空洞になる）。
//
// **いま通しているのは `docs-gate` と `lint-config` の 2 本だけ。** `gate-scripts` /
// `contract-database` / `dotenv-env-loading` は各自の子プロセス用ヘルパーを持っており、
// `error` / `signal` を捨てて `status` だけを見る形が残っている（`not.toBe(0)` は
// `status: null` でも通るので、下の fail-open がそのまま当てはまる）。**移行は別の変更で行う** —
// ここで「写しは無い」と書かないのは、無い物を在ると書いた検出網の説明が穴になるため。
// `spawnSync` はコマンドが見つからないときも時間切れのときも `status: null` を返すので、
// 「非 0 なら合格」の書き方は**何も測れていない状態で緑**になる（§9 fail-closed）。逆に
// `execFileSync` で例外だけを捕まえる形にすると、ENOENT（git が無い）と「git が走って
// エラーを返した」が同じ catch へ落ち、失敗の文言が**起きていない原因**を名指しする。
import { expect } from 'vitest';
import { spawnSync } from 'node:child_process';

// 子プロセスの待ち時間の上限 (npx がレジストリを見に行って張り付くのを防ぐ)
export const CHILD_TIMEOUT_MS = 180_000;

// 子プロセスが実際に起動して正常に終わったことを確かめる。
// **`status` の null を素通りさせない**（上のコメントの理由）
export function expectRan(result: ReturnType<typeof spawnSync>, label: string): void {
  // **シグナルを先に見る。** 時間切れは `error` (ETIMEDOUT) と `signal` (SIGTERM) の
  // **両方**が立つので (実測)、`error` を先に見ると時間切れが常に「起動できなかった」で
  // 落ち、このモジュールが避けるために在る「起きていない原因の名指し」をしてしまう
  expect(result.signal, `${label} が途中で打ち切られた (時間切れ・シグナル)`).toBeNull();
  // 起動そのものに失敗していないこと (ENOENT など)。**理由のコードも出す** —
  // ENOENT (実行ファイルが無い) と EACCES (権限) を取り違えないため
  expect(
    result.error,
    `${label} を起動できなかった${result.error ? ` (${(result.error as NodeJS.ErrnoException).code ?? result.error.message})` : ''}`,
  ).toBeUndefined();
  // 終了コードが数値であること (null のまま判定へ進ませない)
  expect(typeof result.status, `${label} の終了コードが取れていない`).toBe('number');
}

// git が追跡しているパスを取る（`-z` は NUL 区切り。改行を含むパスでも壊れない）。
// **前提（git の作業ツリーであること）を名指しして落とす** — `.git` が無い配布物でも
// `git` の無い環境でも、失敗の理由を取り違えずに読めるようにする
export function gitTrackedFiles(pathspec: string): string[] {
  // 追跡集合を聞く
  const result = spawnSync('git', ['ls-files', '-z', '--', pathspec], {
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
  });
  // 起動と終了の仕方をまず確かめる（ENOENT・時間切れをここで分ける）
  expectRan(result, `git ls-files -- ${pathspec}`);
  // **走って失敗した場合は git 自身の出力を見せる** — 所有者違い (`dubious ownership`)・
  // 権限・index の破損がここへ来るので、原因を 1 つに決め打ちしない（§6）
  expect(
    result.status,
    `git ls-files -- ${pathspec} が失敗した（この検査は git の作業ツリーを前提にしている）: ${result.stderr?.trim() ?? ''}`,
  ).toBe(0);
  // NUL で割って空を落とす
  return result.stdout.split('\0').filter((line) => line.length > 0);
}
