// 既存ユーザーにログイントークンを発行する開発用 CLI (seed 後の最初のトークン取得に使う。ADR-0005)。
//   npx tsx scripts/issue-user-token.ts --email admin@example.com [--tenant default-tenant] [--name CLI] [--days 90]
// 平文は標準出力に 1 度だけ表示し、DB にはハッシュだけを保存する
// .env を読む (Prisma 7 のクライアントは接続文字列を自力で探さない)
import 'dotenv/config';
// 引数解析 (Node 標準)
import { parseArgs } from 'node:util';
// prisma アダプタとクライアント結線
import { createPrismaRepos } from '../src/data/adapters/prisma';
// 10 進整数の判定 (API の limit と同じ規則。0x10 / 1e2 / ' 5 ' を通さない)
import { parseDecimalInteger } from '../src/domain/decimal-integer';
// メールの正規化 (API と同じ規則で検索する)
import { normalizeEmail } from '../src/domain/email';
import { createPrismaClient } from '../src/lib/prisma-client';
// 既定の有効期間
import { DEFAULT_TENANT_ID, USER_TOKEN_DEFAULT_TTL_DAYS } from '../src/lib/constants';
// 用途名と有効期間の規則 (API の POST /users/{id}/tokens と同じスキーマで検証し、規則を書き写さない)
import { userTokenCreateSchema } from '../src/lib/validations/user-token';
// トークン生成
import { issueSecret, userTokenExpiresAt } from '../src/lib/tokens';

// CLI 本体
async function main(): Promise<void> {
  // 引数を読む
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      tenant: { type: 'string', default: DEFAULT_TENANT_ID },
      name: { type: 'string', default: 'CLI' },
      days: { type: 'string', default: String(USER_TOKEN_DEFAULT_TTL_DAYS) },
    },
  });
  // メールは必須
  if (!values.email) throw new Error('--email <メールアドレス> を指定してください。');
  // 用途名と日数は API と同じスキーマで検証する (10 進整数でない --days は NaN にして数値の検証で落とす)
  const parsed = userTokenCreateSchema.safeParse({
    name: values.name,
    expiresInDays: parseDecimalInteger(values.days!) ?? Number.NaN,
  });
  if (!parsed.success) {
    // どの引数がどう誤りかを 1 行ずつ示す (name → --name、expiresInDays → --days)
    const lines = parsed.error.issues.map(
      (issue) => `--${issue.path[0] === 'name' ? 'name' : 'days'}: ${issue.message}`,
    );
    throw new Error(`引数が不正です。\n${lines.join('\n')}`);
  }
  const { name, expiresInDays: days } = parsed.data;
  // DB へ接続する
  const client = createPrismaClient();
  const repos = createPrismaRepos(client);
  // 対象ユーザーをテナント内でメールで引く (テナント内で一意)
  try {
    // 複合一意 (tenantId, email) で検索する
    const user = await repos.users.findByEmail(values.tenant!, normalizeEmail(values.email));
    if (!user)
      throw new Error(`ユーザーが見つかりません: ${values.email} (tenant=${values.tenant})`);
    if (user.disabledAt !== null) throw new Error('このユーザーは無効化されています。');
    // 平文を発行し、ハッシュだけ保存する
    const issued = issueSecret('user');
    const token = await repos.userTokens.create({
      tenantId: user.tenantId,
      userId: user.id,
      prefix: issued.prefix,
      tokenHash: issued.hash,
      name,
      expiresAt: userTokenExpiresAt(days),
    });
    if (!token) throw new Error('トークンを発行できませんでした。');
    // 平文はここで 1 度だけ表示する
    console.log(
      `発行しました (${user.email} / ${user.role} / 期限 ${token.expiresAt.toISOString()})`,
    );
    console.log(`Authorization: Bearer ${issued.secret}`);
  } finally {
    // 接続を閉じる
    await client.$disconnect();
  }
}

// 実行し、失敗したら非 0 終了にする (エラーを握り潰さない)
main().catch((error) => {
  console.error('発行失敗:', error instanceof Error ? error.message : error);
  process.exit(1);
});
