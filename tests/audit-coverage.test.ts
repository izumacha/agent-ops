// 監査ログの語彙（`src/domain/audit/action.ts`）が**実際に発行されているか**を見張る。
//
// **なぜ要るか**: 語彙は定義しただけでは何も記録しない。実測で `agent.budget_exceeded` が
// 定義だけされていて発行箇所が 1 つも無く、予算超過で中継を断った 403 は監査ログにも台帳にも
// 1 行も残っていなかった（運用者からは「通信が止まったのに記録がどこにも無い」状態）。
// 型検査もテストも lint もこれを見ない — 定義は正しく、使っていないだけなので eslint の
// 未使用検査にも掛からない（export されているため）。
//
// **期待は語彙の表から導く**ので、値を足した人が発行箇所を書き忘れたら落ちる。
// 判定はソースの綴りではなく **TypeScript のパーサ**で `AuditAction.<キー>` の
// プロパティアクセスを数える（コメントや文字列の中の綴りを拾わない）。
import { describe, expect, it } from 'vitest';
import { relative } from 'node:path';
import ts from 'typescript';
import { AuditAction, AuditTargetType } from '@/domain/audit/action';
import { forEachNode, parseSourceFiles, SRC_DIR } from './lib/source-files';

// 語彙を宣言しているファイル（ここでの出現は「発行」ではない）
const DECLARING_FILE = 'domain/audit/action.ts';

/**
 * `<定数名>.<キー>` の形で読まれているキーを src 全体から集める。
 * **宣言しているファイル自身は数えない** — そこには必ず全キーが現れるので、数えると常に緑になる。
 * @param holder 定数の名前（`AuditAction` など）
 * @returns 読まれていたキーの集合
 */
function readKeysOf(holder: string): Set<string> {
  // 見つかったキー
  const used = new Set<string>();
  // src 全体を構文木で走査する
  for (const parsed of parseSourceFiles()) {
    // 宣言しているファイルは対象外
    if (relative(SRC_DIR, parsed.path).split('\\').join('/') === DECLARING_FILE) continue;
    // プロパティアクセスを探す
    forEachNode(parsed.source, (node) => {
      // `X.y` の形で X がその定数名なら、y を使っていることになる
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === holder
      ) {
        used.add(node.name.text);
      }
    });
  }
  // 読まれていたキー
  return used;
}

describe('監査ログの語彙', () => {
  it('すべての操作名が src のどこかから発行されている', () => {
    // 語彙の表（正本）
    const declared = Object.keys(AuditAction);
    // 1 つも読めなければ走査が壊れている (fail-closed)
    expect(declared.length, '操作名を 1 つも読めない').toBeGreaterThan(0);
    // src で実際に読まれているキー
    const used = readKeysOf('AuditAction');
    // 1 つも見つからなければ走査が壊れている (fail-closed。「使われていない」と区別できないため)
    expect(used.size, 'src で読まれている操作名が 0 件 (走査が壊れている)').toBeGreaterThan(0);
    for (const key of declared) {
      // その操作名が発行されていること
      expect(
        used.has(key),
        `AuditAction.${key} を発行している箇所が src に無い (記録しているつもりで何も残らない)`,
      ).toBe(true);
    }
  });

  it('すべての対象種別が src のどこかから使われている', () => {
    // 対象種別も同じ理由で見張る (使われない種別は画面から資源を引く経路も持たない)
    const declared = Object.keys(AuditTargetType);
    expect(declared.length, '対象種別を 1 つも読めない').toBeGreaterThan(0);
    const used = readKeysOf('AuditTargetType');
    expect(used.size, 'src で読まれている対象種別が 0 件 (走査が壊れている)').toBeGreaterThan(0);
    for (const key of declared) {
      expect(used.has(key), `AuditTargetType.${key} を使っている箇所が src に無い`).toBe(true);
    }
  });
});
