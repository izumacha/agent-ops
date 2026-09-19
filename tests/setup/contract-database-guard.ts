// 契約テストの接続先ガード (vitest の setupFiles として全テストファイルの前に走る)。
// 契約テストは beforeEach で全テーブルを TRUNCATE するため、開発 DB を指したまま走らせると seed 済みデータが消える。
// npm script の入口ガード (scripts/require-contract-env.mjs) は vitest を直接叩く / IDE のテストランナー /
// --watch では通らないので、テスト側でも必ず通る位置に置く。個々のテストファイルの beforeAll に書くと
// 2 本目の契約テストを足した人が呼び忘れられるため、ファイルではなく設定側に置いている。
// 注意: RUN_PRISMA_CONTRACT を shell に export したまま `npm run test` を叩くと、純粋なユニットテストも
// 含めて全ファイルがここで落ちる (意図した fail-closed。接続先を確かめずに DB を触らせないため)。
// 判定と「走った印」は共有関数が持つ (ここで書き分けると、判定だけ消えても印が残って検査が空回りする)
import { runContractDatabaseGuard } from '../../scripts/lib/contract-database.mjs';

// ガードを走らせる
runContractDatabaseGuard();
