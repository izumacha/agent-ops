// 既存ユーザーにログイントークンを発行する開発用 CLI (seed 後の最初のトークン取得に使う。ADR-0005)。
//   npx tsx scripts/issue-user-token.ts --email admin@example.com [--tenant default-tenant] [--name CLI] [--days 90]
// 平文は標準出力に 1 度だけ表示し、DB にはハッシュだけを保存する
// .env を読む (Prisma 7 のクライアントは接続文字列を自力で探さない)
import 'dotenv/config';
// 引数解析 (Node 標準)
import { parseArgs } from 'node:util';
// prisma アダプタとクライアント結線
import { createPrismaRepos } from '../src/data/adapters/prisma';
// メールの正規化 (API と同じ規則で検索する)
import { normalizeEmail } from '../src/domain/email';
import { createPrismaClient } from '../src/lib/prisma-client';
// 既定の有効期間
import {
  DEFAULT_TENANT_ID,
  USER_TOKEN_DEFAULT_TTL_DAYS,
  USER_TOKEN_MAX_TTL_DAYS,
} from '../src/lib/constants';
// トークン生成
import { displayPrefix, generateSecret, hashSecret, userTokenExpiresAt } from '../src/lib/tokens';

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
  // 日数は 1〜上限の整数
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > USER_TOKEN_MAX_TTL_DAYS) {
    throw new Error(`--days は 1〜${USER_TOKEN_MAX_TTL_DAYS} の整数で指定してください。`);
  }
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
    // 平文を生成し、ハッシュだけ保存する
    const secret = generateSecret('user');
    const token = await repos.userTokens.create({
      tenantId: user.tenantId,
      userId: user.id,
      prefix: displayPrefix(secret),
      tokenHash: hashSecret(secret),
      name: values.name!,
      expiresAt: userTokenExpiresAt(days),
    });
    if (!token) throw new Error('トークンを発行できませんでした。');
    // 平文はここで 1 度だけ表示する
    console.log(
      `発行しました (${user.email} / ${user.role} / 期限 ${token.expiresAt.toISOString()})`,
    );
    console.log(`Authorization: Bearer ${secret}`);
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
