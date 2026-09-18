// `npm run test:contract` の入口ガード。契約テストは RUN_PRISMA_CONTRACT=1 と実 DB の DATABASE_URL が無いと
// describe.skipIf で全件 skip され、それでも vitest は exit 0 で終わる (= 1 件も検証していないのに緑)。
// CI のステップから環境変数が落ちても気付けない fail-open なので、ここで先に落とす (§9 fail-closed)。
// 全体テスト (`npm run test`) では skip のままでよい — 生成物や DB が無い環境でも動くことが狙いだから

// 契約テストを走らせるための環境変数 (CLAUDE.md §2 と CI の contract ステップが同じ値を使う)
const FLAG = 'RUN_PRISMA_CONTRACT';
// 契約テスト専用 DB の名前に要求する接尾辞 (CI と CLAUDE.md §2 が使う agent_ops_contract に合わせる)
const REQUIRED_DATABASE_SUFFIX = '_contract';

// 接続文字列からデータベース名を取り出す (取り出せなければ null)
function databaseNameOf(url) {
  // URL として解釈できなければ判定できない
  try {
    // パス先頭の / を除いた部分がデータベース名
    return new URL(url).pathname.replace(/^\//, '') || null;
  } catch {
    // 解釈できない形は判定できない
    return null;
  }
}

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

// 接続先のデータベース名
const database = databaseNameOf(process.env.DATABASE_URL);
// 専用 DB の名前でなければ落とす (開発 DB を指したまま走ると seed 済みのデータを TRUNCATE で消す。
// 「指さないこと」と書くだけでは、開発用の DATABASE_URL を export している人が必ず踏む)
if (database === null || !database.endsWith(REQUIRED_DATABASE_SUFFIX)) {
  console.error(
    `[test:contract] DATABASE_URL のデータベース名は "${REQUIRED_DATABASE_SUFFIX}" で終わる専用 DB にしてください` +
      ` (今の指定: ${database ?? '解釈できない形'})`,
  );
  console.error(
    '[test:contract] 全テーブルを TRUNCATE するため、開発 DB を指すと seed 済みデータが消えます',
  );
  process.exit(1);
}
