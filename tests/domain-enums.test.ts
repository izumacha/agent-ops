// Vitest のテスト API
import { describe, expect, it } from 'vitest';
// ドメイン層の enum 定義 (正準)
import * as domain from '@/domain/types';
// Prisma が生成した enum (DB 側の真実。値 import はこのテストだけに閉じる)
import * as generated from '@/generated/prisma';

// 突き合わせる enum の名前一覧 (ドメイン側に enum を足したらここにも足す)
const ENUM_NAMES = [
  'Plan',
  'Role',
  'AgentStatus',
  'Provider',
  'RuleKind',
  'RuleAction',
  'IncidentStatus',
] as const;

describe('ドメイン層の enum は Prisma の enum と一致する', () => {
  // enum ごとに値の集合が完全一致することを固定する
  for (const name of ENUM_NAMES) {
    it(`${name} の値が prisma/schema.prisma と同じ`, () => {
      // ドメイン側の値一覧
      const ours = Object.values(domain[name]).sort();
      // Prisma 側の値一覧 (生成物は { key: value } のオブジェクト)
      const theirs = Object.values(generated[name] as Record<string, string>).sort();
      // 集合として一致すること
      expect(ours).toEqual(theirs);
    });
  }
});
