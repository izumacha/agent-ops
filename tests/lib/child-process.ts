// テストから子プロセスを起こす共通部分。
//
// **ここが「起動できなかった」と「走って失敗した」を分ける判定の置き場所。**
// 挙動は `tests/child-process-helper.test.ts` が合成入力で固定する（順序を戻しても CI では
// 緑のままなので、テストで押さえないと役割が空洞になる）。
//
// **通しているのは `docs-gate` / `lint-config` / `gate-scripts` の 3 本。** 残る
// `contract-database` と `dotenv-env-loading` は各自のヘルパーを持っているが、どちらも
// `status` の null を自分で弾いている（前者は `typeof status` を `'number'` と比べ、
// 後者は `toBe(0)` なので null が通らない）ので、下の fail-open は**当てはまらない**。
// 移行すれば文言が揃うという利点だけで、閉じるべき穴は残っていない。
// `spawnSync` はコマンドが見つからないときも時間切れのときも `status: null` を返すので、
// 「非 0 なら合格」の書き方は**何も測れていない状態で緑**になる（§9 fail-closed）。逆に
// `execFileSync` で例外だけを捕まえる形にすると、ENOENT（git が無い）と「git が走って
// エラーを返した」が同じ catch へ落ち、失敗の文言が**起きていない原因**を名指しする。
import { expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';

// 子プロセスの待ち時間の上限 (npx がレジストリを見に行って張り付くのを防ぐ)
export const CHILD_TIMEOUT_MS = 180_000;

// vitest 側の上限に足す余裕 (起動・後片付けの分)
const TEST_TIMEOUT_MARGIN_MS = 30_000;

// 子プロセスを `children` 本起こすテストに渡す上限（子の本数ぶん＋余裕）。
//
// **実測しておく（誤解しやすいので）**: `it()` の上限と子の上限を**同値**にしても、
// vitest の「Test timed out in …」が勝つことは無かった — `spawnSync` は同期で
// イベントループを塞ぐので、子側の上限が先に効いて関数が戻り、`expectRan` の
// 「完走しなかった (シグナルで終了: ETIMEDOUT)」が出た。**同値が壊れているわけではない。**
//
// それでも余裕を足すのは、子の時間切れの**あと**に走る後片付け・assertion・
// 複数の子の合計がテストの締め切りを押し出すのを避けるため（2 本起こす
// `lint-config` が実際にこの形）。**既定の 5 秒のまま放置しない**ことが要点で、
// そのときだけは原因を言わない「Test timed out in 5000ms」になる
export function testBudgetFor(children: number): number {
  // 子の本数ぶんの上限＋余裕
  return children * CHILD_TIMEOUT_MS + TEST_TIMEOUT_MARGIN_MS;
}

// 子プロセスが実際に起動して正常に終わったことを確かめる。
// **`status` の null を素通りさせない**（上のコメントの理由）
export function expectRan(result: ReturnType<typeof spawnSync>, label: string): void {
  // 失敗の理由 (errno)。**どちらの文言にも出す** — 時間切れ (ETIMEDOUT) と
  // 出力の上限超過 (ENOBUFS) は**どちらも `signal: 'SIGTERM'` を立てる**ので (実測)、
  // シグナルだけを見た文言は「時間切れ」と決め打ちしてしまい、理由が消える
  const reason = result.error
    ? ((result.error as NodeJS.ErrnoException).code ?? result.error.message)
    : '';
  // **シグナルを先に見る。** 時間切れは `error` (ETIMEDOUT) と `signal` (SIGTERM) の
  // **両方**が立つので (実測)、`error` を先に見ると時間切れが常に「起動できなかった」で
  // 落ち、このモジュールが避けるために在る「起きていない原因の名指し」をしてしまう
  expect(
    result.signal,
    `${label} が完走しなかった (シグナルで終了${reason ? `: ${reason}` : ''})`,
  ).toBeNull();
  // 起動そのものに失敗していないこと (ENOENT など)。**理由のコードも出す** —
  // ENOENT (実行ファイルが無い) と EACCES (権限) を取り違えないため
  expect(
    result.error,
    `${label} を起動できなかった${reason ? ` (${reason})` : ''}`,
  ).toBeUndefined();
  // 終了コードが数値であること (null のまま判定へ進ませない)
  expect(typeof result.status, `${label} の終了コードが取れていない`).toBe('number');
}

// git が追跡しているパスを取る（`-z` は NUL 区切り。改行を含むパスでも壊れない）。
// **前提（git の作業ツリーであること）を名指しして落とす** — `.git` が無い配布物でも
// `git` の無い環境でも、失敗の理由を取り違えずに読めるようにする
export function gitTrackedFiles(pathspec: string): string[] {
  // **根からの相対で出させる。** git は既定でカレントからの相対で出すので、カレントが
  // リポジトリの下位ディレクトリだと呼び出し側が突き合わせているリテラル（`docs/…` /
  // `prisma/schema.prisma`）と**静かに**食い違う。`--full-name` と `:/` 付きの pathspec を
  // 使えばカレントに依存しない（実測。`tests/lib` から呼んでも `docs/…` が返る）。
  // **`import.meta.url` から `..` を数えて根を決める形にはしない** — このファイルを移すと
  // 根が静かにずれ、しかも git は下位ディレクトリでも exit 0 で（別の相対で）出すので
  // どの検査も鳴らない（実測）。カレントがリポジトリ外のときは git が非 0 で落ち、
  // 下の検査が前提を名指しする
  const magic = pathspec === '.' ? ':/' : `:/${pathspec}`;
  // 追跡集合を聞く
  const result = spawnSync('git', ['ls-files', '--full-name', '-z', '--', magic], {
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
  });
  // 結果の読み方は純粋関数へ（挙動を合成入力で固定できるようにする）
  return interpretTrackedFiles(result, pathspec);
}

// `git ls-files` の結果を読む判定。**子プロセスを起こさないので合成入力で挙動を固定できる** —
// ここを空にしても全件緑のままだったので（実測。件数も変わらない）、
// `tests/child-process-helper.test.ts` がこの関数を直接呼んで押さえる
export function interpretTrackedFiles(
  result: SpawnSyncReturns<string>,
  pathspec: string,
): string[] {
  // 起動と終了の仕方をまず確かめる（ENOENT・シグナルをここで分ける）
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
