// .env を読む (Prisma 7 のクライアントは接続文字列を自力で探さないため、seed も自分で読む)
import 'dotenv/config';
// ドライバアダプタの結線を 1 か所に集めたファクトリ
import { createPrismaClient } from '../src/lib/prisma-client';
// 開発・デモ用テナントの固定 id (CLI と共有する唯一の定義)
import { DEFAULT_TENANT_ID } from '../src/domain/tenant';
// 投入するデモデータの定義 (値の正本。テストから検査できるよう DB 非依存のモジュールに置いている)
import { DEMO_AGENT, DEMO_TENANT_NAME, DEMO_TENANT_PLAN, DEMO_USERS } from './seed-data';

// seed 本体: デモ用のテナント・管理者・エージェントを冪等に投入する
async function main(): Promise<void> {
  // DB へ接続するクライアントを作る
  const prisma = createPrismaClient();
  // 既定テナント (無ければ作成、あれば名前だけ更新)
  const tenant = await prisma.tenant.upsert({
    where: { id: DEFAULT_TENANT_ID },
    update: { name: DEMO_TENANT_NAME },
    create: { id: DEFAULT_TENANT_ID, name: DEMO_TENANT_NAME, plan: DEMO_TENANT_PLAN },
  });
  // デモユーザーを 1 人ずつ投入する (既にいれば何も変えない = 冪等)
  for (const user of DEMO_USERS) {
    // テナント内でメールアドレスが一意なので、それを鍵に upsert する
    await prisma.user.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email: user.email } },
      update: {},
      create: { tenantId: tenant.id, email: user.email, name: user.name, role: user.role },
    });
  }
  // サンプルエージェント
  await prisma.agent.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: DEMO_AGENT.name } },
    update: {},
    create: { tenantId: tenant.id, ...DEMO_AGENT },
  });
  // 接続を閉じる
  await prisma.$disconnect();
  // 投入結果を表示する (人数は定義から導く。散文の写しが古くなるのを防ぐ)
  console.log(`seed 完了: テナント / ユーザー ${DEMO_USERS.length} 名 / エージェント 1 件`);
}

// 実行し、失敗したら非 0 終了にする (エラーを握り潰さない)
main().catch((error) => {
  console.error('seed 失敗:', error);
  process.exit(1);
});
