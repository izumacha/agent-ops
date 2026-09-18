// 生 SQL の実行時ガード (src/lib/raw-sql-guard.ts)。
// 綴りを走査する静的検査は 1 段の間接化 (分割代入・別名・計算添字) で崩れるため、値そのものを見る
// このガードが本体になる。ここが空洞だと検出網の中心が無いのと同じなので、挙動を直接固定する
import { describe, expect, it, vi } from 'vitest';
import { guardRawSql, UnsafeRawSqlError } from '@/lib/raw-sql-guard';

// タグ付きテンプレートの第 1 引数を作る (テストから明示的に呼ぶため)
function template(...strings: string[]): TemplateStringsArray {
  // 文字列の配列に raw を足したものがタグ付きテンプレートの第 1 引数
  return Object.assign([...strings], { raw: [...strings] }) as unknown as TemplateStringsArray;
}

// 生 SQL のメソッドを持つ偽のクライアント (呼ばれたかどうかを記録する)
function fakeClient() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $transaction: vi.fn((callback: (tx: unknown) => unknown) => callback(fakeClient())),
    user: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

describe('guardRawSql', () => {
  it('値を素通しするメソッドは呼んだ時点で落ちる', async () => {
    // 包んだクライアント
    const client = fakeClient();
    const guarded = guardRawSql(client);
    // どちらも呼べない
    expect(() => guarded.$queryRawUnsafe('SELECT 1')).toThrow(UnsafeRawSqlError);
    expect(() => guarded.$executeRawUnsafe('SELECT 1')).toThrow(UnsafeRawSqlError);
    // 本物には 1 度も届いていない
    expect(client.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(client.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('タグ付きテンプレートで、埋め込みがパラメータになる値なら通す', async () => {
    // 包んだクライアント
    const client = fakeClient();
    const guarded = guardRawSql(client);
    // 文字列・数値・日時・null・配列はパラメータとして送れる
    await guarded.$queryRaw(template('SELECT ', ' ', ' ', ''), 'x', 42, new Date());
    await guarded.$executeRaw(template('UPDATE ', ''), null);
    await guarded.$queryRaw(template('SELECT ', ''), [1, 2, 3]);
    // 本物へ届いている
    expect(client.$queryRaw).toHaveBeenCalledTimes(2);
    expect(client.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('SQL 断片を埋め込む形は落ちる (Prisma.raw の結果を変数で受けても同じ)', async () => {
    // 包んだクライアント
    const client = fakeClient();
    const guarded = guardRawSql(client);
    // Prisma.raw が返すのは「SQL 断片」のオブジェクト。変数に入れて埋め込んでも値は同じなので落ちる
    const fragment = { strings: [`id = 'x'`], values: [], sql: `id = 'x'` };
    expect(() => guarded.$queryRaw(template('SELECT ', ''), fragment)).toThrow(UnsafeRawSqlError);
    // 入れ子 (配列の中の断片) も落ちる
    expect(() => guarded.$queryRaw(template('SELECT ', ''), [fragment])).toThrow(UnsafeRawSqlError);
    // 本物には届いていない
    expect(client.$queryRaw).not.toHaveBeenCalled();
  });

  it('タグ付きでない呼び方 (文字列を組み立てて渡す) は落ちる', async () => {
    // 包んだクライアント
    const client = fakeClient();
    const guarded = guardRawSql(client);
    // 文字列を渡す形は、$queryRaw という綴りでも中身は素通し
    expect(() => guarded.$queryRaw(`SELECT * FROM "User" WHERE id = 'x'`)).toThrow(
      UnsafeRawSqlError,
    );
    expect(client.$queryRaw).not.toHaveBeenCalled();
  });

  it('トランザクション内のクライアントも同じガードを通る', async () => {
    // 包んだクライアント
    const client = fakeClient();
    const guarded = guardRawSql(client);
    // コールバックが受け取る tx でも危険な呼び方は落ちる (実際の行ロックはここに書かれている)
    await expect(
      guarded.$transaction(async (tx: unknown) => {
        // 受け取った tx も包まれているので、危険な呼び方はここで落ちる
        (tx as { $queryRawUnsafe: (sql: string) => unknown }).$queryRawUnsafe('SELECT 1');
      }),
    ).rejects.toThrow(UnsafeRawSqlError);
  });

  it('生 SQL 以外の操作はそのまま通る', async () => {
    // 包んだクライアント
    const client = fakeClient();
    const guarded = guardRawSql(client);
    // モデル経由の操作は素通し
    await guarded.user.findMany();
    expect(client.user.findMany).toHaveBeenCalledTimes(1);
  });
});
