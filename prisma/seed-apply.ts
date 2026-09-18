// seed の投入手順そのもの (どのクライアントへ流すかは呼び出し側が決める)。
//
// 分けている理由: `prisma/seed.ts` は読み込むだけで `main()` が走って DB へ接続するので、投入手順を
// テストから実行できない。実測では、ユーザーを回すループを `DEMO_USERS.slice(0, 1)` に変えて
// **閲覧専用ユーザーが 1 人も作られない**ようにしても lint・typecheck・全テストが緑のままだった
// (値は prisma/seed-data.ts のテストが見ているが、投入する側は誰も見ていなかった)。
// ここへ出せば契約テストが実 DB に対して「定義どおりに入ったか」を確かめられる
import type { createPrismaClient } from '../src/lib/prisma-client';
// 開発・デモ用テナントの固定 id (CLI と共有する唯一の定義)
import { DEFAULT_TENANT_ID } from '../src/domain/tenant';
// 投入するデモデータの定義 (値の正本)
import { DEMO_AGENT, DEMO_TENANT_NAME, DEMO_TENANT_PLAN, DEMO_USERS } from './seed-data';

// 受け取るクライアントの型 (結線のファクトリが返すものと同じ)
type SeedClient = ReturnType<typeof createPrismaClient>;

/**
 * デモ用のテナント・ユーザー・エージェントを冪等に投入する (何度流しても同じ状態になる)。
 * 呼び出し側が接続と切断を持ち、この関数は投入だけを行う
 */
export async function applySeed(prisma: SeedClient): Promise<void> {
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
}
