// .env を読む (Prisma 7 のクライアントは接続文字列を自力で探さないため、seed も自分で読む)
import 'dotenv/config';
// ドライバアダプタの結線を 1 か所に集めたファクトリ
import { createPrismaClient } from '../src/lib/prisma-client';
// 投入手順の本体 (契約テストが実 DB に対して同じ関数を流して結果を確かめる)
import { applySeed } from './seed-apply';
// 投入するデモデータの定義 (件数の表示に使う)
import { DEMO_USERS } from './seed-data';

// seed 本体: デモ用のテナント・管理者・エージェントを冪等に投入する
async function main(): Promise<void> {
  // DB へ接続するクライアントを作る
  const prisma = createPrismaClient();
  // 投入する
  await applySeed(prisma);
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
