// 接続設定の組み立て (src/lib/prisma-client.ts の buildScopedConnectionConfig)。
// node-postgres は DSN の `options=` を設定オブジェクトの上に重ねるため、DSN 側の options を
// 残したままだと search_path の固定が黙って上書きされる。そうなると Prisma が組み立てるクエリは
// schema オプションで修飾されるのに、**生 SQL (行ロック・SELECT 1) だけ**がサーバ既定の search_path を
// 向き、「ヘルスチェックは通るのに行ロックが別スキーマの User を見る」という静かな壊れ方になる。
// CI の接続先は options を持たないので、この合流は実際の接続経路では一度も通らない
import { describe, expect, it } from 'vitest';
import { buildScopedConnectionConfig } from '@/lib/prisma-client';

describe('buildScopedConnectionConfig', () => {
  it('DSN が options を持たなければ、接続文字列はそのままで search_path だけを足す', () => {
    // options 無しの DSN
    const dsn = 'postgresql://user:pw@host:5432/db?schema=app';
    const config = buildScopedConnectionConfig(dsn, new URL(dsn), 'app');
    // 接続文字列は触らない (再エンコードで壊さない)
    expect(config.connectionString).toBe(dsn);
    // search_path の固定が入る
    expect(config.options).toContain('search_path');
    expect(config.options).toContain('app');
  });

  it('DSN が options を持つときは、両方を残しつつ search_path を後ろに置く', () => {
    // Neon などが使う形 (endpoint の指定を options で渡す)
    const dsn = 'postgresql://user:pw@host:5432/db?schema=app&options=endpoint%3Dep-123';
    const config = buildScopedConnectionConfig(dsn, new URL(dsn), 'app');
    // DSN 側の指定は活きる
    expect(config.options).toContain('endpoint=ep-123');
    // search_path は後ろに置く (後勝ちなので必ず効く)
    expect(config.options.indexOf('search_path')).toBeGreaterThan(
      config.options.indexOf('endpoint=ep-123'),
    );
    // 接続文字列側からは options を取り除く (残すと設定オブジェクトの上に重ねられて上書きされる)
    expect(config.connectionString).not.toContain('options=');
    // schema の指定は残る (Prisma CLI が読む)
    expect(config.connectionString).toContain('schema=app');
  });
});
