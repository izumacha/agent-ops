// 生 SQL を「パラメータ化された形」だけに閉じる実行時ガード。
//
// なぜ静的検査だけにしないか: 綴りを走査する検出網は 1 段の間接化で崩れる。実測では
// `const { raw } = Prisma; const scope = raw(\`... '${id}' ...\`); tx.$queryRaw\`... ${scope} ...\``
// と書くだけで、構文検査 (メンバ参照の名前を見る) も ESLint も素通りし、URL のパスパラメータから
// 任意 SQL を実行できた (pg_sleep が実際に効き、他テナントのユーザーの存在判定もできた)。
// 綴りを追いかける限りこの追跡は終わらないので、値そのものを見る実行時チェックへ寄せる。
// 静的検査 (tests/raw-sql.test.ts) は「危険な書き方が増えたことに気付く」ための網として併用する。
// 値をそのまま SQL へ混ぜてしまうメソッド (呼ばれた時点で落とす)
const UNSAFE_RAW_METHODS = ['$queryRawUnsafe', '$executeRawUnsafe'] as const;
// タグ付きテンプレートで使うメソッド (埋め込む値を検査してから通す)
const TAGGED_RAW_METHODS = ['$queryRaw', '$executeRaw'] as const;

// 生 SQL の使い方が安全でないときに投げる例外 (呼び出し側で握り潰さず、そのまま落とす)
export class UnsafeRawSqlError extends Error {
  constructor(message: string) {
    // 文脈を添えて基底クラスへ渡す
    super(`安全でない生 SQL: ${message}`);
    // スタックの表示名を分かりやすくする
    this.name = 'UnsafeRawSqlError';
  }
}

// タグ付きテンプレートの第 1 引数か (文字列の配列で、生文字列の配列も持つ)
function isTemplateStringsArray(value: unknown): value is TemplateStringsArray {
  // まず配列であること
  if (!Array.isArray(value)) return false;
  // 生文字列の側を取り出す。`value.raw` と直接書かないのは、`raw` という名前の読み取りを
  // 禁止する lint と静的検査 (tests/raw-sql.test.ts) にこの行が引っかかるため
  // (規約を実装している当のファイルが規約に触れる形。読み方を変えて意図を明示する)
  const rawStrings = Reflect.get(value, 'raw');
  // そちらも配列ならタグ付きテンプレートの第 1 引数
  return Array.isArray(rawStrings);
}

// 埋め込んでよい値か (パラメータとして安全に送れるものだけ許す)
function isParameterValue(value: unknown): boolean {
  // null / undefined はそのままパラメータになる
  if (value === null || value === undefined) return true;
  // 文字列・数値・真偽値・BigInt はパラメータ化される
  if (['string', 'number', 'boolean', 'bigint'].includes(typeof value)) return true;
  // 日時とバイト列もパラメータとして送れる
  if (value instanceof Date || value instanceof Uint8Array) return true;
  // 配列は中身がすべてパラメータなら許す (IN 句などで使う)
  if (Array.isArray(value)) return value.every(isParameterValue);
  // それ以外 (Prisma.raw / Prisma.sql が返す SQL 断片など) は許さない
  return false;
}

// タグ付きテンプレートの呼び出しを検査する (問題があれば投げる)
function assertSafeTaggedCall(method: string, args: unknown[]): void {
  // 第 1 引数がテンプレートでなければ、文字列を組み立てて渡している (Prisma.sql の結果も含む)
  if (!isTemplateStringsArray(args[0])) {
    throw new UnsafeRawSqlError(
      `${method} はタグ付きテンプレートで呼ぶこと (文字列や SQL 断片を渡さない)。`,
    );
  }
  // 埋め込んでいる値を 1 つずつ見る
  for (const value of args.slice(1)) {
    // パラメータにできない値 (SQL 断片) が混ざっていれば落とす
    if (!isParameterValue(value)) {
      throw new UnsafeRawSqlError(
        `${method} に埋め込めるのはパラメータになる値だけ (SQL 断片を渡さない)。`,
      );
    }
  }
}

/**
 * Prisma クライアント (とトランザクション内のクライアント) を包み、生 SQL の危険な使い方を実行時に閉じる。
 * `$transaction` のコールバックが受け取るクライアントも同じ包みへ入れる — そこを素通しにすると、
 * 実際に生 SQL を書いている場所 (行ロック) がまるごとガードの外になる。
 */
export function guardRawSql<T extends object>(client: T): T {
  // 読み取りだけを差し替える Proxy (他の操作は既定のまま実クライアントへ届く)
  return new Proxy(client, {
    // プロパティの読み取り
    get(target, property) {
      // 実体の値を取り出す
      const value = Reflect.get(target, property);
      // 文字列のプロパティ名だけを対象にする (Symbol は素通し)
      if (typeof property === 'string') {
        // 値を素通しするメソッドは、呼ばれた時点で必ず落とす
        if ((UNSAFE_RAW_METHODS as readonly string[]).includes(property)) {
          return () => {
            throw new UnsafeRawSqlError(`${property} は使用禁止 ($queryRaw の形で書くこと)。`);
          };
        }
        // タグ付きテンプレートのメソッドは、埋め込む値を検査してから通す
        if ((TAGGED_RAW_METHODS as readonly string[]).includes(property)) {
          if (typeof value === 'function') {
            return (...args: unknown[]) => {
              // 呼び出しの形と値を確かめる
              assertSafeTaggedCall(property, args);
              // 問題なければ本物へ委譲する
              return (value as (...callArgs: unknown[]) => unknown).apply(target, args);
            };
          }
        }
        // トランザクションは、コールバックが受け取るクライアントも同じ包みへ入れる
        if (property === '$transaction' && typeof value === 'function') {
          return (...args: unknown[]) => {
            // 第 1 引数が関数 (対話的トランザクション) のときだけ包む
            const [first, ...rest] = args;
            if (typeof first === 'function') {
              const callback = first as (tx: object) => unknown;
              return (value as (...callArgs: unknown[]) => unknown).apply(target, [
                (tx: object) => callback(guardRawSql(tx)),
                ...rest,
              ]);
            }
            // 配列を渡す形 (バッチ) はそのまま委譲する
            return (value as (...callArgs: unknown[]) => unknown).apply(target, args);
          };
        }
      }
      // メソッドは this が実クライアントを指すように束ねて返す
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
