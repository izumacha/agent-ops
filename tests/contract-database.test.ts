// 契約テストを流してよい接続先の規則 (scripts/lib/contract-database.mjs)。
// 入口ガード (npm run test:contract) と契約テスト本体の両方がこの 1 か所を読むので、ここが壊れると
// 2 つのガードが同時に fail-open になり、開発 DB を指したまま TRUNCATE が走る。
// 規則を 1 か所へ集めた代わりに、その 1 か所は必ず検査する (写しを見張る他の検出網と同じ役割)
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_DATABASE_SUFFIX,
  contractDatabaseProblem,
} from '../scripts/lib/contract-database.mjs';

describe('契約テスト専用 DB の判定', () => {
  // CI のステップと CLAUDE.md §2 が使う DB 名 (agent_ops_contract) が通ること
  it('接尾辞が一致する接続先だけを許す', () => {
    // 専用 DB (問題なし = null)
    expect(contractDatabaseProblem('postgresql://u:p@h:5432/agent_ops_contract')).toBeNull();
    // クエリが付いていても DB 名は変わらない
    expect(
      contractDatabaseProblem('postgresql://u:p@h:5432/agent_ops_contract?schema=x'),
    ).toBeNull();
  });

  // 判定できない形も含めて拒否すること (不明なら拒否 = fail-closed)
  it('開発 DB・未設定・解釈できない形はすべて拒否する', () => {
    // 拒否されるべき接続先
    const rejected = [
      'postgresql://u:p@h:5432/agent_ops', // 開発 DB (seed 済みデータが消える)
      'postgresql://u:p@h:5432/', // DB 名が空
      'not a url', // URL として解釈できない
      '', // 空文字
      undefined, // 未設定
    ];
    // どれも理由の文言が返ること
    for (const url of rejected) {
      expect(contractDatabaseProblem(url), String(url)).not.toBeNull();
    }
  });

  // 接尾辞そのものを固定する (CI のステップと CLAUDE.md §2 に同じ名前が散文で出てくる)
  it('要求する接尾辞は _contract', () => {
    // 定数の値
    expect(CONTRACT_DATABASE_SUFFIX).toBe('_contract');
  });
});
