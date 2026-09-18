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
// 列挙にすると、漏れた入口がそのままガードの外に残る (実測では $queryRawInternal /
// $executeRawInternal から実際に SQL が走った。$runCommandRaw は MongoDB 専用で PostgreSQL には
// 存在しないが、形で捉える以上ここも自然に含まれる)。
// 安全なもの ($queryRawTyped) まで塞ぐが、fail-closed 側に倒す (必要になったら許可側へ明示的に足す)
const RAW_METHOD_PATTERN = /^\$.*Raw/;
// 拡張クライアントを作るメソッド。**包み直さず、呼んだ時点で落とす** —
// Prisma の拡張は `client` / `model` の中で `this` や Prisma.getExtensionContext(this) として
// **素の拡張クライアント**を渡すので、戻り値だけを包んでも中から外へ出られる (実測で SQL が走った)。
// 拡張が本当に要るようになったら、そのとき「ガードをどう掛けるか」を決めてからここを開ける
const CLIENT_EXTENDING_METHOD = '$extends';

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

/**
 * Prisma クライアント (とトランザクション内のクライアント) を包み、生 SQL の危険な使い方を実行時に閉じる。
 *
 * **クライアントから読めるオブジェクトはすべて同じ包みへ入れ直す。** 特定のプロパティ
 * (`$parent` など) だけを包む形にすると、そこから漏れた 1 ホップで外へ出られる — 実測では
 * モデルデリゲート (`prisma.tenant` / `tx.user`) にも `$parent` が生えており、そこから素の
 * クライアントを取り出して任意 SQL を実行できた。`$transaction` のコールバックが受け取る
 * クライアントも同じ包みへ入れる (実際に生 SQL を書いている行ロックはその中にある)。
 * 拡張 (`$extends`) だけは包み直さず禁止する (理由は定数の注記)。
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
      // 名前で判定する分岐は文字列のプロパティだけ (Symbol は下の「オブジェクトなら包む」で扱う)
      if (typeof property === 'string') {
        // 拡張クライアントを作るメソッドは呼ばせない (戻り値を包んでも拡張の中から素の実体が漏れる)
        if (property === CLIENT_EXTENDING_METHOD && typeof value === 'function') {
          return remember(target, property, value, () => () => {
            throw new UnsafeRawSqlError(
              `${property} は使用禁止 (拡張の中から包みの外のクライアントを取り出せるため)。`,
            );
          });
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
      if (typeof value === 'function') {
        return remember(target, property, value, () =>
          (value as (...a: unknown[]) => unknown).bind(target),
        );
      }
      // オブジェクト (モデルデリゲート・$parent・Symbol キーで持っている内部の参照) は同じ包みへ入れる。
      // ここを素通しにすると、`tx.user.$parent` のように 1 ホップでガードの外のクライアントに届く
      if (typeof value === 'object' && value !== null) {
        return remember(target, property, value, () => guardRawSql(value));
      }
      // それ以外 (数値・文字列など) はそのまま返す
      return value;
    },
  });
  // 次に同じ実体を包むときのために覚えておく
  guardedByClient.set(client, guarded);
  return guarded;
}
