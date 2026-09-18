// `npm run test:contract` の入口ガード。契約テストは RUN_PRISMA_CONTRACT=1 と実 DB の DATABASE_URL が無いと
// describe.skipIf で全件 skip され、それでも vitest は exit 0 で終わる (= 1 件も検証していないのに緑)。
// CI のステップから環境変数が落ちても気付けない fail-open なので、ここで先に落とす (§9 fail-closed)。
// 全体テスト (`npm run test`) では skip のままでよい — 生成物や DB が無い環境でも動くことが狙いだから

// 接続先が専用 DB かの判定 (契約テスト本体と同じ規則を 1 か所から読む)
import { contractDatabaseProblem } from './lib/contract-database.mjs';

// 契約テストを走らせるための環境変数 (CLAUDE.md §2 と CI の contract ステップが同じ値を使う)
const FLAG = 'RUN_PRISMA_CONTRACT';

// 不足している設定を集める
const missing = [];
// フラグが 1 でなければ契約テストは 1 件も走らない
if (process.env[FLAG] !== '1') missing.push(`${FLAG}=1`);
// 接続先が無ければ Prisma クライアントの生成時点で落ちる
if (!process.env.DATABASE_URL) missing.push('DATABASE_URL (契約テスト専用 DB を指すこと)');

// 1 つでも欠けていれば理由を示して終了する
if (missing.length > 0) {
  console.error(`[test:contract] 次の設定が必要です: ${missing.join(' / ')}`);
  console.error(
    '[test:contract] 開発 DB を指さないこと (beforeEach で全テーブルを TRUNCATE する)。手順は CLAUDE.md §2',
  );
  process.exit(1);
}

// 専用 DB の名前でなければ落とす (開発 DB を指したまま走ると seed 済みのデータを TRUNCATE で消す。
// 「指さないこと」と書くだけでは、開発用の DATABASE_URL を export している人が必ず踏む)
const problem = contractDatabaseProblem(process.env.DATABASE_URL);
if (problem !== null) {
  console.error(`[test:contract] ${problem}`);
  console.error(
    '[test:contract] 全テーブルを TRUNCATE するため、開発 DB を指すと seed 済みデータが消えます',
  );
  process.exit(1);
}
