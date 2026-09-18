// 生 SQL を「パラメータ化された形」だけに閉じる実行時ガード。
//
// なぜ静的検査だけにしないか: 綴りを走査する検出網は 1 段の間接化で崩れる。実測では
// `const { raw } = Prisma; const scope = raw(\`... '${id}' ...\`); tx.$queryRaw\`... ${scope} ...\``
// と書くだけで、構文検査 (メンバ参照の名前を見る) も ESLint も素通りし、URL のパスパラメータから
// 任意 SQL を実行できた (pg_sleep が実際に効き、他テナントのユーザーの存在判定もできた)。
// 綴りを追いかける限りこの追跡は終わらないので、値そのものを見る実行時チェックへ寄せる。
// 静的検査 (tests/raw-sql.test.ts) は「危険な書き方が増えたことに気付く」ための網として併用する。
// タグ付きテンプレートで使うメソッド (埋め込む値を検査してから通す)。**ここに挙げたものだけが通る**
const TAGGED_RAW_METHODS = new Set<string>(['$queryRaw', '$executeRaw']);
// 生 SQL の入口の綴り。危険な名前を列挙するのではなく「$ で始まり Raw を含む」という形で捉える —
// 列挙にすると、漏れた入口 ($queryRawInternal / $executeRawInternal / $runCommandRaw など、
// 実測でいずれも実際に SQL が走った) がそのままガードの外に残る。
// 安全なもの ($queryRawTyped) まで塞ぐが、fail-closed 側に倒す (必要になったら許可側へ明示的に足す)
const RAW_METHOD_PATTERN = /^\$.*Raw/;
// クライアント自身 (またはそれを返す関数) を持つプロパティ。同じ包みへ入れ直さないと 1 ホップで外へ出られる —
// 実測では `tx.$parent` と `client.$extends({})` の両方から、ガードを通らない生 SQL に到達できた
const CLIENT_VALUED_PROPERTIES = new Set<string>(['$extends', '$parent']);

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
  // 生文字列の側も配列ならタグ付きテンプレートの第 1 引数
  return Array.isArray((value as { raw?: unknown }).raw);
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
  // それ以外 (Prisma.raw / Prisma.sql が返す SQL 断片など) は許さない。
  // 素のオブジェクトも拒否するので、JSON 列をパラメータで渡したくなったらここを明示的に広げること
  // (黙って緩めると SQL 断片まで通る。広げるときは「断片だけを弾く」形にする)
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

// 実体 → 包み の対応表 (同じ実体には同じ包みを返す)
const guardedByClient = new WeakMap<object, object>();

// 実体 → プロパティ名 → 直前に返した値 の表。Proxy の get は呼ばれるたびに値を作るので、
// 覚えておかないと `client.$transaction === client.$transaction` が false になる
// (src/lib/prisma.ts が「同じ参照で解除する」ために保っている性質が、包んだ瞬間に壊れる)
const wrappedByClient = new WeakMap<
  object,
  Map<PropertyKey, { source: unknown; value: unknown }>
>();

// 同じ実体・同じプロパティ・同じ実体側の値なら、前回作ったものを返す
function remember(
  target: object,
  property: PropertyKey,
  source: unknown,
  make: () => unknown,
): unknown {
  // この実体用の表 (無ければ作る)
  let cache = wrappedByClient.get(target);
  if (cache === undefined) {
    cache = new Map<PropertyKey, { source: unknown; value: unknown }>();
    wrappedByClient.set(target, cache);
  }
  // 実体側の値が前回と同じなら、前回の結果を使い回す (差し替えられていたら作り直す)
  const cached = cache.get(property);
  if (cached !== undefined && cached.source === source) return cached.value;
  // 作って覚える
  const value = make();
  cache.set(property, { source, value });
  return value;
}

// オブジェクトなら同じ包みへ入れ、そうでなければそのまま返す
function wrapIfObject(value: unknown): unknown {
  // クライアントとして使える形 (オブジェクト) だけ包む
  return typeof value === 'object' && value !== null ? guardRawSql(value) : value;
}

/**
 * Prisma クライアント (とトランザクション内のクライアント) を包み、生 SQL の危険な使い方を実行時に閉じる。
 * `$transaction` のコールバックが受け取るクライアントも、`$extends` / `$parent` が返すクライアントも
 * 同じ包みへ入れ直す — どれか 1 つでも素通しにすると、実際に生 SQL を書いている場所 (行ロック) から
 * 1 ホップでガードの外へ出られる。
 */
export function guardRawSql<T extends object>(client: T): T {
  // 同じ実体には同じ包みを返す (包み直すたびに別の Proxy を作ると、`$parent` を往復しただけで
  // 参照が食い違い、呼び出し側の「同じ関数で解除する」といった前提が崩れる)
  const existing = guardedByClient.get(client);
  if (existing !== undefined) return existing as T;

  // 読み取りだけを差し替える Proxy (他の操作は既定のまま実クライアントへ届く)
  const guarded = new Proxy(client, {
    // プロパティの読み取り
    get(target, property) {
      // 実体の値を取り出す
      const value = Reflect.get(target, property);
      // 文字列のプロパティ名だけを対象にする (Symbol は素通し)
      if (typeof property === 'string') {
        // クライアントを返すプロパティは、返ってくるものを同じ包みへ入れ直す
        if (CLIENT_VALUED_PROPERTIES.has(property)) {
          return remember(target, property, value, () =>
            typeof value === 'function'
              ? (...args: unknown[]) =>
                  wrapIfObject((value as (...a: unknown[]) => unknown).apply(target, args))
              : wrapIfObject(value),
          );
        }
        // タグ付きテンプレートのメソッドは、埋め込む値を検査してから通す
        if (TAGGED_RAW_METHODS.has(property)) {
          if (typeof value === 'function') {
            return remember(target, property, value, () => (...args: unknown[]) => {
              // 呼び出しの形と値を確かめる
              assertSafeTaggedCall(property, args);
              // 問題なければ本物へ委譲する
              return (value as (...callArgs: unknown[]) => unknown).apply(target, args);
            });
          }
        }
        // 上で許した形以外の生 SQL の入口は、呼ばれた時点で必ず落とす
        // (関数でなければ呼べないので、そのまま返す)
        if (RAW_METHOD_PATTERN.test(property) && typeof value === 'function') {
          return remember(target, property, value, () => () => {
            throw new UnsafeRawSqlError(
              `${property} は使用禁止 (タグ付きテンプレートの $queryRaw / $executeRaw で書くこと)。`,
            );
          });
        }
        // トランザクションは、コールバックが受け取るクライアントも同じ包みへ入れる
        if (property === '$transaction' && typeof value === 'function') {
          return remember(target, property, value, () => (...args: unknown[]) => {
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
          });
        }
      }
      // メソッドは this が実クライアントを指すように束ねて返す (毎回束ね直すと参照が食い違うので覚えておく)
      return typeof value === 'function'
        ? remember(target, property, value, () =>
            (value as (...a: unknown[]) => unknown).bind(target),
          )
        : value;
    },
  });
  // 次に同じ実体を包むときのために覚えておく
  guardedByClient.set(client, guarded);
  return guarded;
}
