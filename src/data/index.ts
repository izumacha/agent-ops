// Composition Root: API 層が使うリポジトリの束を 1 か所で決める。
// 本番は prisma アダプタ (遅延生成の singleton 経由)、テストは setReposForTesting で memory アダプタへ差し替える
import { prisma } from '@/lib/prisma';
import { createPrismaRepos } from './adapters/prisma';
import type { Repositories } from './ports';

// テストが差し込んだ束 (未設定なら本番の束を使う)
let overrideRepos: Repositories | undefined;
// 本番の束 (初回アクセス時に組み立てる。prisma singleton 自体も遅延生成なので import だけでは DB に触らない)
let prismaRepos: Repositories | undefined;

// 現在有効なリポジトリの束を返す (Route Handler はこれだけを呼ぶ)
export function getRepos(): Repositories {
  // テストの差し替えがあればそれを優先する
  if (overrideRepos) return overrideRepos;
  // 本番の束を初回だけ組み立てる (prisma singleton は遅延生成の Proxy なので、ここでも DB にはまだ触らない)
  prismaRepos ??= createPrismaRepos(prisma);
  // 本番の束
  return prismaRepos;
}

// テスト専用: リポジトリの束を差し替える (undefined で本番へ戻す)。本番では呼べない (fail-closed)
export function setReposForTesting(repos: Repositories | undefined): void {
  // 本番ビルドで差し替えられると全データが別実装へ向くので拒否する
  if (process.env.NODE_ENV === 'production') {
    throw new Error('setReposForTesting は本番では使えません。');
  }
  // 差し替える
  overrideRepos = repos;
}

// Port と型を再公開する (利用側は src/data だけを import する)
export type * from './ports';
export { DuplicateError } from './errors';
