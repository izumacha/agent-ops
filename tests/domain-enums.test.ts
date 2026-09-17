// Vitest のテスト API
import { describe, expect, it } from 'vitest';
// ドメイン層の enum 定義 (正準)
import * as domain from '@/domain/types';
// Prisma が生成した enum (DB 側の真実。値 import はこのテストだけに閉じる)
import { $Enums } from '@/generated/prisma';

// ドメイン側で enum として公開している名前 (as const のオブジェクトだけを拾う。型は実行時に無い)
const domainEnumNames = Object.entries(domain)
  .filter(([, value]) => typeof value === 'object' && value !== null)
  .map(([name]) => name)
  .sort();
// Prisma 側の enum 名 (生成物の $Enums のキー)
const prismaEnumNames = Object.keys($Enums).sort();

describe('ドメイン層の enum は Prisma の enum と一致する', () => {
  it('enum の名前一覧が両側で一致する (片側にだけ足した取りこぼしを落とす)', () => {
    // 手書きの一覧を持たず、両側から導いた集合を突き合わせる
    expect(domainEnumNames).toEqual(prismaEnumNames);
  });

  // enum ごとに値の集合が完全一致することを固定する
  for (const name of prismaEnumNames) {
    it(`${name} の値が prisma/schema.prisma と同じ`, () => {
      // ドメイン側の値一覧 (名前一覧の一致は上のテストが担保する)
      const ours = Object.values(
        (domain as unknown as Record<string, Record<string, string>>)[name] ?? {},
      ).sort();
      // Prisma 側の値一覧
      const theirs = Object.values(($Enums as Record<string, Record<string, string>>)[name]).sort();
      // 集合として一致すること
      expect(ours).toEqual(theirs);
    });
  }
});
