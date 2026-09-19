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

  // 読み取り側と書き込み側の両方に同じ検査を掛ける。片方にしか拒否のケースが無いと、
  // 検査の対象からそちらを外す変異が全件緑で通る (実測: $executeRaw を外すと Prisma.raw を埋めた
  // DELETE がそのまま走った。書き込み側のほうが被害は重い)
  it.each(['$queryRaw', '$executeRaw'] as const)(
    '%s: SQL 断片を埋め込む形は落ちる (Prisma.raw の結果を変数で受けても同じ)',
    (method) => {
      // 包んだクライアント
      const client = fakeClient();
      const guarded = guardRawSql(client);
      // Prisma.raw が返すのは「SQL 断片」のオブジェクト。変数に入れて埋め込んでも値は同じなので落ちる
      const fragment = { strings: [`id = 'x'`], values: [], sql: `id = 'x'` };
      expect(() => guarded[method](template('SELECT ', ''), fragment)).toThrow(UnsafeRawSqlError);
      // 入れ子 (配列の中の断片) も落ちる
      expect(() => guarded[method](template('SELECT ', ''), [fragment])).toThrow(UnsafeRawSqlError);
      // 本物には届いていない
      expect(client[method]).not.toHaveBeenCalled();
    },
  );

  it.each(['$queryRaw', '$executeRaw'] as const)(
    '%s: タグ付きでない呼び方 (文字列を組み立てて渡す) は落ちる',
    (method) => {
      // 包んだクライアント
      const client = fakeClient();
      const guarded = guardRawSql(client);
      // 文字列を渡す形は、正しい綴りでも中身は素通し
      expect(() => guarded[method](`DELETE FROM "User" WHERE id = 'x'`)).toThrow(UnsafeRawSqlError);
      expect(client[method]).not.toHaveBeenCalled();
    },
  );

  it('列挙にない生 SQL の入口も落ちる (名前の形で捉える)', () => {
    // Prisma が内部用に持つ入口。実測ではここから実際に SQL が走った
    const client = {
      ...fakeClient(),
      $queryRawInternal: vi.fn().mockResolvedValue([]),
      $executeRawInternal: vi.fn().mockResolvedValue(0),
      $runCommandRaw: vi.fn().mockResolvedValue({}),
    };
    const guarded = guardRawSql(client);
    // どれも呼べない (危険な名前を列挙する形だと、ここが丸ごと外に残る)
    expect(() => guarded.$queryRawInternal()).toThrow(UnsafeRawSqlError);
    expect(() => guarded.$executeRawInternal()).toThrow(UnsafeRawSqlError);
    expect(() => guarded.$runCommandRaw({})).toThrow(UnsafeRawSqlError);
    // 本物には 1 度も届いていない
    expect(client.$queryRawInternal).not.toHaveBeenCalled();
  });

  it('拡張クライアントは作らせない (拡張の中から包みの外の実体が漏れるため)', () => {
    // 拡張が新しいクライアントを返す実体
    const inner = fakeClient();
    const client = {
      ...fakeClient(),
      // 拡張は「オプションを受け取って新しいクライアントを返す」形 (引数は使わないので受けない)
      $extends: vi.fn(() => inner),
    };
    const guarded = guardRawSql(client);
    // 戻り値を包むのではなく、呼ぶこと自体を拒否する — 拡張は client / model の中で
    // 素の拡張クライアントを this として渡すので、戻り値だけ包んでも中から外へ出られる
    const extend = guarded.$extends as unknown as (options: object) => typeof inner;
    expect(() => extend({})).toThrow(UnsafeRawSqlError);
    // 本物の拡張は 1 度も呼ばれていない
    expect(client.$extends).not.toHaveBeenCalled();
  });

  it('クライアントを辿れるオブジェクト (親・モデルデリゲート) も包み直す', () => {
    // 親クライアントと、$parent を持つモデルデリゲートを備えた実体
    const inner = fakeClient();
    const client = {
      ...fakeClient(),
      $parent: inner,
      // Prisma のモデルデリゲートは $parent を持つ (実測)。ここが素通しだと 1 ホップで外へ出られる
      user: { findMany: vi.fn().mockResolvedValue([]), $parent: inner },
    };
    const guarded = guardRawSql(client);
    // 親クライアント経由
    expect(() => guarded.$parent.$queryRawUnsafe('SELECT 1')).toThrow(UnsafeRawSqlError);
    // モデルデリゲート経由 (アダプタはすべてのメソッドでデリゲートを触るので、ここが本命の経路)
    expect(() => guarded.user.$parent.$queryRawUnsafe('SELECT 1')).toThrow(UnsafeRawSqlError);
    // 本物には届いていない
    expect(inner.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('同じプロパティを 2 回読んでも同じ参照を返す', () => {
    // 包んだクライアント
    const guarded = guardRawSql(fakeClient());
    // 包むたびに新しい関数を作ると、「登録したハンドラを同じ参照で解除する」が効かなくなる
    expect(guarded.$queryRaw).toBe(guarded.$queryRaw);
    expect(guarded.$transaction).toBe(guarded.$transaction);
    expect(guarded.$queryRawUnsafe).toBe(guarded.$queryRawUnsafe);
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
    // モデル経由の操作は素通し (包んでも通常の呼び出しは壊れない)
    await guarded.user.findMany();
    expect(client.user.findMany).toHaveBeenCalledTimes(1);
  });

  // **守備範囲の境界を固定する。** ガードのトラップは `get` 1 つなので、
  // プロパティの読み取り以外の内省 (プロトタイプ・own descriptor) は包まれない。
  // ここを閉じるには `getPrototypeOf` を包み直すしかないが、**返すのが別オブジェクトになるため
  // `instanceof` が成立しなくなる**ので意図的に開けてある (理由はモジュール冒頭のコメント)。
  // この境界をテストで書き留めておくのは 2 つの理由から:
  //   - モジュールの説明と実態がずれないようにする (説明だけが強いと、読み手が
  //     「このガードがあるから生 SQL は必ずパラメータ化される」と読み切ってしまう)
  //   - 将来ここを**閉じた**ときにこのテストが落ちるので、説明の更新が必ず一度は目に入る
  it('プロトタイプ経由・own descriptor 経由は包まれない (意図した境界。静的な網と規約で守る)', () => {
    // 生 SQL のメソッドを**プロトタイプ上**に持つクライアント (生成物の PrismaClient と同じ形)
    class PrototypeShapedClient {
      $queryRawUnsafe(sql: string): string {
        return `RAN:${sql}`;
      }
    }
    // 包んだクライアント
    const onPrototype = guardRawSql(new PrototypeShapedClient());
    // 通常の読み取りはガードに当たる (ここが本来の守備範囲)
    expect(() => onPrototype.$queryRawUnsafe('SELECT 1')).toThrow(UnsafeRawSqlError);
    // プロトタイプから直接取ると包みを通らない (= 守備範囲外)
    const fromPrototype = Object.getPrototypeOf(onPrototype) as PrototypeShapedClient;
    expect(fromPrototype.$queryRawUnsafe.call(onPrototype, 'SELECT 1')).toBe('RAN:SELECT 1');
    // 自分自身のプロパティとして持つ形では、descriptor から取ると包みを通らない
    const onSelf = guardRawSql({ $queryRawUnsafe: (sql: string) => `RAN:${sql}` });
    expect(() => onSelf.$queryRawUnsafe('SELECT 1')).toThrow(UnsafeRawSqlError);
    const descriptor = Object.getOwnPropertyDescriptor(onSelf, '$queryRawUnsafe');
    expect((descriptor?.value as (sql: string) => string)('SELECT 1')).toBe('RAN:SELECT 1');
  });
});
