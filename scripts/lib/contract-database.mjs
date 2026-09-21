// 契約テストを流してよい接続先の規則。`npm run test:contract` の入口ガード (scripts/require-contract-env.mjs)・
// vitest の setupFiles (tests/setup/contract-database-guard.ts)・契約テスト本体
// (tests/data/*.contract.prisma.test.ts) がここを読む。
// 複数の位置で見張るのは、入口ガードを通らない起動 (vitest の直叩き / IDE のテストランナー / --watch) があるため。
// ただし規則そのものを両方へ書き写すと片方だけ古くなるので、判定はこのファイルだけに置く (§6 DRY)

// ガードが走ったことを示す印を置く場所 (globalThis のキー)。印を立てるのは下の runContractDatabaseGuard で、
// この定数は名前を配るだけ (import しただけでは印が付かないので、印を確かめるテストから参照できる)
export const CONTRACT_GUARD_MARKER = '__agentOpsContractDatabaseGuardRan';

// 契約テスト専用 DB の名前に要求する接尾辞 (CI と CLAUDE.md §2 が使う agent_ops_contract に合わせる)
export const CONTRACT_DATABASE_SUFFIX = '_contract';

// 接続文字列からデータベース名を取り出す (取り出せなければ null)
function databaseNameOf(url) {
  // 未設定なら名前も無い
  if (!url) return null;
  // URL として解釈できなければ判定できない
  try {
    // パス先頭の / を除いた部分がデータベース名
    return new URL(url).pathname.replace(/^\//, '') || null;
  } catch {
    // 解釈できない形は判定できない
    return null;
  }
}

/**
 * 接続先が契約テスト専用 DB かを判定する。
 * 問題があれば理由の文言を返し、専用 DB なら null を返す (開発 DB を指したまま走ると
 * beforeEach の TRUNCATE が seed 済みデータを消すため、判定できない形も拒否する = fail-closed)
 */
export function contractDatabaseProblem(url) {
  // 接続先のデータベース名
  const database = databaseNameOf(url);
  // 専用 DB の名前なら問題なし
  if (database !== null && database.endsWith(CONTRACT_DATABASE_SUFFIX)) return null;
  // 駄目な理由を組み立てて返す
  return (
    `DATABASE_URL のデータベース名は "${CONTRACT_DATABASE_SUFFIX}" で終わる専用 DB にしてください` +
    ` (今の指定: ${database ?? '解釈できない形'})`
  );
}

/**
 * ベンチの接続先ガード。専用 DB でなければ理由を表示して非 0 終了する。
 *
 * **判定と終了を 1 つの関数にまとめるのが要点** — 呼び出し側で
 * `const problem = contractDatabaseProblem(...); if (problem !== null && 何か) throw ...` と
 * 書けると、条件を 1 つ足すだけでガードが実質外れる (実測で全件緑だった)。
 *
 * **環境変数を引数で受け取らない。** 受け取れるようにしていたときは、呼び出し側が
 * `requireContractDatabase('bench:usage', { DATABASE_URL: '…_contract' })` と偽の env を
 * 渡すだけでガードが完全に死んだ (実測で 713 件すべて緑のまま、開発 DB への `TRUNCATE` に到達)。
 * テストから判定を確かめたいときは `contractDatabaseProblem` を直接呼ぶ。
 *
 * **残る境界: 「引数で受け取らない」だけでは import 時の書き換えを防げない。**
 * ESM は import した側のどのトップレベル文よりも先に import 先を評価するので、ベンチが取り込む
 * モジュール (`scripts/lib/*.mjs` / `src/**`) のトップレベルで `process.env.DATABASE_URL` を
 * 書き換えられると、このガードは書き換え後の値を見て黙って通る (実測: 専用 DB でない接続先を
 * 指したまま `TRUNCATE` まで到達し、検出網は全件緑だった)。
 * **これは静的検査では閉じきれない** — import 時の副作用を走査で禁じると、正当なモジュール
 * 初期化のたびに許可リストへの追加を強いられ、その許可リスト自体が緩む圧力になる。
 * 一方この形は差分に露骨に現れる (`src/domain/types.ts` の末尾に env の代入が生える) ので、
 * **規約とレビューで守る**。検出網が守るのは「差分を見ても悪意に見えない変更」のほう
 * @param {string} label ゲート/ベンチの名前 (失敗の文言に入れる)
 */
export function requireContractDatabase(label) {
  // 駄目な理由 (専用 DB なら null)
  const problem = contractDatabaseProblem(process.env.DATABASE_URL);
  // 専用 DB なら何もしない
  if (problem === null) return;
  // 理由を表示して落とす (`exitIfFailures` と同じ形。トップレベルで throw するとスタックが出る)
  console.error(`[${label}] 専用 DB でだけ実行してください: ${problem}`);
  // 非 0 終了 (1 件も書かずに止める)
  process.exit(1);
}

/**
 * 契約テストの接続先ガード本体。走った印を置き、専用 DB でなければ throw する。
 * 印と判定を同じ関数に入れるのが要点 — 印だけ別に置くと、判定を消しても印は付いたままになり
 * 「結線を見張るテスト」が緑のまま通る (実測)。env を引数に取るのはテストから直接呼べるようにするため
 * @param {Record<string, string | undefined>} [env] 読み取る環境変数 (既定は実際の環境)
 */
export function runContractDatabaseGuard(env = process.env) {
  // 走った印 (結線が外れていないことをテストが確かめる)
  globalThis[CONTRACT_GUARD_MARKER] = true;
  // 契約テストを走らせる合図が無ければ、DB を触るテストは丸ごと skip されるので判定も要らない
  if (env.RUN_PRISMA_CONTRACT !== '1') return;
  // 駄目な理由 (専用 DB なら null)
  const problem = contractDatabaseProblem(env.DATABASE_URL);
  // 専用 DB でなければ、テストを 1 件も走らせずに落とす (fail-closed)。
  // 逃げ道も文言に書く — 契約テストを流すつもりが無いのに全テストが赤くなると、
  // 「うるさいから」とガードごと外される動機になる (赤が常態になった検査はいずれ緩められる)
  if (problem !== null) {
    throw new Error(
      `契約テストは専用 DB でだけ実行してください: ${problem}` +
        '（契約テストを流さないときは RUN_PRISMA_CONTRACT を外してください）',
    );
  }
}
