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
// YAML の読み口（CI のジョブの上限を読む）
import { readYaml } from './yaml';

// 子プロセスの待ち時間の上限 (npx がレジストリを見に行って張り付くのを防ぐ)
export const CHILD_TIMEOUT_MS = 180_000;

// **実測（この機械、2026-10-08）**: いちばん子を多く起こすテスト（negative control の
// 最悪ケース＝`gate-step7`）は子 17 本で 10.4 秒＝1 本 0.61 秒、15 本起こす共有モジュールの
// import が 0.84 秒＝1 本 0.06 秒。
//
// **この 2 つを定数として持つのは、下の見積もりの「下限」をテストから引くため。**
// 見積もりそのものは遅い CI ランナーを見込んだ数字なので、**実測と一致させる意味はない**
// （締めると遅い機械で原因の分からない赤になる）。固定できるのは
// 「この機械で実測した走行時間すら覆えない値へ縮める退行」までで、
// `tests/child-process-helper.test.ts` がそれを落とす
export const MEASURED_WIDEST_CHILD_COUNT = 17;
export const MEASURED_WIDEST_RUNTIME_MS = 10_400;

// 子プロセス 1 本が正常に走り終わるまでの見積もり（本数ぶん積む分）。
//
// **「約 8 倍」が成り立つのはシムを噛ませた軽い子に対してだけ**（上の実測 1 本 0.61 秒）。
// 本物の `npm` を起こす呼び出し側はこれより重く、この機械では `npx eslint` が 0.5 秒、
// **`npm run lint` が 8.3 秒**で、1 本ぶんの見積もりを既に超えている（実測）。
// それでも締め切りが足りているのは**張り付いた 1 本ぶん（180 秒）が支配的**だからで、
// 「どの子でも 8 倍の余裕がある」とは読まないこと。下限の検査が引くのもシム側の実測だけ
const PER_CHILD_RUNTIME_ALLOWANCE_MS = 5_000;

// vitest 側の上限に足す余裕 (起動・後片付けの分)
const TEST_TIMEOUT_MARGIN_MS = 30_000;

// 子プロセスを `children` 本起こすテストに渡す `it()` の上限。
//
// **この上限が守っているのは 1 つだけ**: 子が張り付いたとき、**子側の上限が先に効いて**
// `expectRan` の「完走しなかった (…: ETIMEDOUT)」という原因を名指しした assertion が出ること。
// vitest の「Test timed out in …」が先に出ると、原因を言わない赤になる。
//
// **実測しておく（誤解しやすいので）**: `it()` の上限と子の上限を**同値**にしても、
// vitest の締め切りが勝つことは無かった — `spawnSync` は同期でイベントループを塞ぐので、
// 子側の上限が先に効いて関数が戻る。**同値が壊れているわけではない。**
//
// **「本数 × 子の上限」で積まない。** 張り付きうるのは実質 1 本だけで、最初に張り付いた子で
// assertion が落ちてテストは終わる（この repo の呼び出し側はどれも、時間切れの子を
// `expectRan` か `typeof status === 'number'` で必ず落とす）。本数ぶん積むと、子を 17 本
// 起こすテストの上限が **51.5 分**になり、**CI の `gate` ジョブの `timeout-minutes: 45` を
// 超える** — そうなるとジョブ側が先に死ぬので、この上限が買っているはずの「原因を名指しした
// assertion」は一度も出ない（＝短すぎる締め切りを、意味のない締め切りに置き換えただけになる）。
// 実際 PR #26 の時点では本数ぶん積む形で、しかも 17 本・15 本のテストが 1 本ぶんの上限
// （210 秒）を渡していた。**ジョブの上限を超えないことは
// `tests/gate-scripts.test.ts` が `.github/workflows/ci.yml` から導いて見張る。**
//
// 内訳は「張り付いた 1 本ぶん ＋ 残りが正常に走る見積もり ＋ 後片付けの余裕」。
// **既定の 5 秒のまま放置しない**ことが要点で、そのときだけは原因を言わない
// 「Test timed out in 5000ms」になる。
//
// **渡す本数が正しいかは機械で見張っていない** — `testBudgetFor(1)` と書いたまま子を
// 17 本起こすテストにしても、上側の検査（CI のジョブの上限を超えないこと）は落ちない。
// 子を起こす形を変えたときに本数も直すのは規約とレビューで守る
export function testBudgetFor(children: number): number {
  // 張り付いた 1 本ぶん＋本数ぶんの正常な走行時間＋余裕
  const budget =
    CHILD_TIMEOUT_MS + children * PER_CHILD_RUNTIME_ALLOWANCE_MS + TEST_TIMEOUT_MARGIN_MS;
  // **CI のジョブの上限を超える締め切りは作らせない（fail-closed）。**
  // 超えるとジョブ側が先に死ぬので、この締め切りが買っているはずの「原因を名指しした
  // assertion」が一度も出ない（＝短すぎる締め切りを、意味のない締め切りに置き換えただけ）。
  // **判定を「いちばん子を多く起こすテスト」の外側に置かない** — 外側（`tests/gate-scripts.test.ts`）
  // に置くと、そこが導いている 2 形（negative control の行列・共有モジュールの import）に
  // 当てはまらない新しいテストが黙って検査から外れる。ここなら**本数をどこから渡しても**効く
  if (budget >= gateJobTimeoutMs())
    throw new Error(
      `子を ${children} 本起こすテストの締め切り (${budget}ms) が CI の gate ジョブの ` +
        `timeout-minutes (${gateJobTimeoutMs()}ms) 以上になっている` +
        '（本数ぶん子の上限を積む形へ戻していないか。ジョブが先に死ぬと、' +
        '子の時間切れを名指しした assertion が出ない）',
    );
  // 呼び出し側は `it()` の第 3 引数に渡す
  return budget;
}

// CI の `gate` ジョブ（ユニットテストが走るジョブ）に書かれた上限をミリ秒で読む。
// **数字を書き写さない**（ジョブ側を縮めたときにこちらだけが古くなる）。
// 1 回読んだら覚える（`testBudgetFor` はテストの収集中に何度も呼ばれる）
let gateJobTimeoutCache: number | undefined;
export function gateJobTimeoutMs(): number {
  // 覚えている値があればそれを返す
  if (gateJobTimeoutCache !== undefined) return gateJobTimeoutCache;
  // ワークフロー定義（CI の正本）。読み口は共有（マージキーの解決と fail-closed はそちら）
  const jobs = readYaml('.github', 'workflows', 'ci.yml').jobs as
    Record<string, { 'timeout-minutes'?: number } | undefined> | undefined;
  // `gate` ジョブの上限（分）
  const minutes = jobs?.gate?.['timeout-minutes'];
  // **読めなければ落とす**（fail-closed。ジョブ名や項目が変わったら、この検査が
  // 黙って「上限なし」になるのを避ける）
  if (typeof minutes !== 'number')
    throw new Error('.github/workflows/ci.yml の gate ジョブから timeout-minutes を読めない');
  // ミリ秒へ直して覚える
  gateJobTimeoutCache = minutes * 60_000;
  // 呼び出し側（締め切りの天井）が使う
  return gateJobTimeoutCache;
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

// リポジトリのルートを git に聞く。**`expect` を使わない**（モジュール評価時にも呼べるように
// するため。失敗は前提を名指しした素の Error で落とす）。
//
// **これが要るのは `gitTrackedFiles` との組になってはじめて意味を持つから。** あちらは根からの
// 相対でパスを返すので、読む側が `process.cwd()` で解決すると**カレントがリポジトリの下位
// ディレクトリのときだけ**すべて「無い」ことになり、fail-closed の文言が
// 「作業ツリーでない可能性」と**起きていない原因**を名指しする（実測）。両方を根に合わせる
export function repoRoot(): string {
  // 根を聞く
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
  });
  // 読み方は純粋関数へ（子プロセスを起こさないので合成入力で挙動を固定できる）
  return interpretRepoRoot(result);
}

// `git rev-parse --show-toplevel` の結果を読む判定。**`expect` を使わず素の Error で落とす**
// （モジュール評価時にも呼べるようにするため）。
//
// **子プロセスを起こさないので `tests/child-process-helper.test.ts` が合成入力で挙動を固定する** —
// `interpretTrackedFiles` と同じ理由で、ここを空にしても全件緑のままだった（実測）。
// とくに下の「シグナルを先に見る」は、実際の時間切れを起こさないと再現しないので
// 合成入力でしか押さえられない
export function interpretRepoRoot(result: SpawnSyncReturns<string>): string {
  // 失敗の理由（errno）。**どちらの文言にも出す** — `expectRan` と同じ理由
  const reason = result.error
    ? ((result.error as NodeJS.ErrnoException).code ?? result.error.message)
    : '';
  // **シグナルを先に見る。** 時間切れは `error` (ETIMEDOUT) と `signal` (SIGTERM) の**両方**を
  // 立てるので（実測）、`error` を先に見ると時間切れが常に「起動できなかった」で落ち、
  // このモジュールが避けるために在る「起きていない原因の名指し」をしてしまう
  // （`expectRan` は同じ理由でこの順にしてあり、ここだけ逆だった）
  if (result.signal !== null) {
    // シグナルと errno の両方を見せて、原因を決め打ちしない
    throw new Error(
      `git rev-parse --show-toplevel が完走しなかった (${result.signal}${reason ? `: ${reason}` : ''})`,
      result.error ? { cause: result.error } : undefined,
    );
  }
  // 起動そのものに失敗した場合（git が無い・権限）
  if (result.error) {
    // 理由（errno）を添えて落とす
    throw new Error(`git rev-parse --show-toplevel を起動できなかった (${reason})`, {
      cause: result.error,
    });
  }
  // 走って失敗した場合（作業ツリーでない・所有者違い・index の破損）
  if (result.status !== 0) {
    // 前提と git 自身の出力を見せる
    throw new Error(
      `git rev-parse --show-toplevel が失敗した（この検査は git の作業ツリーを前提にしている）: ${result.stderr?.trim() ?? ''}`,
    );
  }
  // 末尾の改行を落とした絶対パス
  return result.stdout.trim();
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
