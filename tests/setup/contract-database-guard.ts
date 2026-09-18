// 契約テストの接続先ガード (vitest の setupFiles として全テストファイルの前に走る)。
// 契約テストは beforeEach で全テーブルを TRUNCATE するため、開発 DB を指したまま走らせると seed 済みデータが消える。
// npm script の入口ガード (scripts/require-contract-env.mjs) は vitest を直接叩く / IDE のテストランナー /
// --watch では通らないので、テスト側でも必ず通る位置に置く。個々のテストファイルの beforeAll に書くと
// 2 本目の契約テストを足した人が呼び忘れられるため、ファイルではなく設定側に置いている
import {
  CONTRACT_GUARD_MARKER,
  contractDatabaseProblem,
} from '../../scripts/lib/contract-database.mjs';

// 走ったことを示す印を置く (この印が無ければ結線が外れている。tests/contract-database.test.ts が確かめる)
(globalThis as Record<string, unknown>)[CONTRACT_GUARD_MARKER] = true;

// 契約テストを走らせる合図 (これが無いときは DB を触るテストが丸ごと skip されるので判定も要らない)。
// 注意: この合図を shell に export したまま `npm run test` を叩くと、純粋なユニットテストも含めて
// 全ファイルがここで落ちる (意図した fail-closed。接続先を確かめずに DB を触らせないため)
if (process.env.RUN_PRISMA_CONTRACT === '1') {
  // 駄目な理由 (専用 DB なら null)
  const problem = contractDatabaseProblem(process.env.DATABASE_URL);
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
