// 契約テストを流してよい接続先の規則。`npm run test:contract` の入口ガード (scripts/require-contract-env.mjs) と
// 契約テスト本体 (tests/data/*.contract.prisma.test.ts) の両方がここを読む。
// 2 か所で見張るのは、入口ガードを通らない起動 (vitest の直叩き / IDE のテストランナー / --watch) があるため。
// ただし規則そのものを両方へ書き写すと片方だけ古くなるので、判定はこのファイルだけに置く (§6 DRY)

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
