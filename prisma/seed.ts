// .env を読む (Prisma 7 のクライアントは接続文字列を自力で探さないため、seed も自分で読む)
import 'dotenv/config';
// enum の正準な参照元
import { Plan, Provider, Role } from '../src/domain/types';
// ドライバアダプタの結線を 1 か所に集めたファクトリ
import { createPrismaClient } from '../src/lib/prisma-client';
// 開発・デモ用テナントの固定 id (CLI と共有する唯一の定義)
import { DEFAULT_TENANT_ID } from '../src/lib/constants';

// seed 本体: デモ用のテナント・管理者・エージェントを冪等に投入する
async function main(): Promise<void> {
  // DB へ接続するクライアントを作る
  const prisma = createPrismaClient();
  // 既定テナント (無ければ作成、あれば名前だけ更新)
  const tenant = await prisma.tenant.upsert({
    where: { id: DEFAULT_TENANT_ID },
    update: { name: 'デモテナント' },
    create: { id: DEFAULT_TENANT_ID, name: 'デモテナント', plan: Plan.free },
  });
  // 管理者ユーザー (実在しないドメインのアドレスのみ使う)
  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'admin@example.com' } },
    update: {},
    create: { tenantId: tenant.id, email: 'admin@example.com', name: '管理者', role: Role.admin },
  });
  // 閲覧専用ユーザー (デモアカウントは最小権限を既定にする §15)
  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'viewer@example.com' } },
    update: {},
    create: { tenantId: tenant.id, email: 'viewer@example.com', name: '閲覧者', role: Role.viewer },
  });
  // サンプルエージェント
  await prisma.agent.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: 'サポート回答ボット' } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: 'サポート回答ボット',
      description: '問い合わせに一次回答するエージェント (デモ)',
      provider: Provider.anthropic,
      model: 'claude-sonnet-4-6',
    },
  });
  // 接続を閉じる
  await prisma.$disconnect();
  // 投入結果を表示する
  console.log('seed 完了: テナント / ユーザー 2 名 / エージェント 1 件');
}

// 実行し、失敗したら非 0 終了にする (エラーを握り潰さない)
main().catch((error) => {
  console.error('seed 失敗:', error);
  process.exit(1);
});
