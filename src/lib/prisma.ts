// 生成された Prisma クライアントの型 (DB 操作の窓口) をインポート
import type { PrismaClient } from '@/generated/prisma';
// ドライバアダプタ込みでクライアントを組み立てる共通ファクトリをインポート
import { createPrismaClient } from './prisma-client';

// PrismaClient が二重に作られないよう、グローバル変数を借りてプロセス内で 1 つに固定する。
// 開発時のホットリロードや、Next.js が入口 (proxy) と app サーバーを別チャンクにバンドルする構成では
// 同一プロセス内でこのモジュールが 2 回評価され、接続プールが 2 本張られる。
// そのため**本番も含めて常に** globalThis にキャッシュする (下の代入に環境の条件を付けない)
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined; // グローバルに保持する Prisma インスタンス (未定義の可能性あり)
};

// 実際に DB へ触るまでクライアントを作らないための遅延生成関数。
// Prisma 7 はドライバアダプタ必須になり、生成時点で接続文字列を要求する (未設定なら fail-closed で落ちる)。
// このモジュールは DB を触らないユニットテストからも import されうるため、生成を初回アクセスまで遅らせる
function getPrismaClient(): PrismaClient {
  // 既に生成済みならそれを返す (globalThis キャッシュ: 上のコメントの理由で本番も含め常に使う)
  globalForPrisma.prisma ??= createPrismaClient({
    // 開発環境では error と warn を表示、本番では error のみに絞る
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });
  // キャッシュ済みのインスタンスを返す
  return globalForPrisma.prisma;
}

// bind し直したメソッドを覚えておく表 (クライアント実体 → プロパティ名 → 束ねた関数)。
// 実クライアントは生 SQL のガード (src/lib/raw-sql-guard.ts) に包まれており、そちら側でも参照を
// 安定させているが、ここでの bind は「ガードを外した構成でも this が実クライアントを指す」ための
// もので、bind し直すと参照が変わるためこの表が要る (二重に見えるが、どちらか片方では成り立たない)。
// 毎回 bind すると `prisma.$transaction === prisma.$transaction` が false になり、
// 「登録したハンドラを同じ参照で解除する」が効かなくなる。
// **キーはクライアント実体**にする (メソッドはインスタンス間で同一の関数オブジェクトなので、
// プロパティ名だけで覚えると差し替わったクライアントに古い束縛を返し続ける)。WeakMap なので回収される
const boundMethodsByClient = new WeakMap<
  PrismaClient,
  Map<PropertyKey, { source: unknown; bound: unknown }>
>();

// 既存の呼び出し側 (`prisma.agent.findMany()` など) を変えずに遅延生成を挟むための Proxy。
// ターゲットは空オブジェクトなので、**転送できる操作はすべて実クライアントへ転送する**
// (get だけだと代入・defineProperty・in・Object.keys が空のターゲット側に落ちて黙って食い違い、
//  テストの `vi.spyOn(prisma, '$transaction')` が「差し替えたつもり」で本物へ行く)。
// 唯一転送できないのが「拡張の禁止」で、こちらは黙って食い違わないよう明示的に失敗させる
export const prisma = new Proxy({} as PrismaClient, {
  // プロパティ読み取り (prisma.agent / prisma.$transaction など) を実クライアントへ委譲する
  get(_target, property) {
    // 実クライアントを取得する (初回のみ生成される)
    const client = getPrismaClient();
    // 目的のプロパティを取り出す。receiver は渡さない —
    // 渡すと getter の this が Proxy になり、実クライアント側の private フィールドを読めなくなる
    const value = Reflect.get(client, property);
    // 関数でなければそのまま返す (モデルデリゲートなどのオブジェクト)
    if (typeof value !== 'function') return value;
    // このクライアント用の表を取り出す (無ければ空の表を作って登録する)
    let boundMethods = boundMethodsByClient.get(client);
    if (!boundMethods) {
      boundMethods = new Map<PropertyKey, { source: unknown; bound: unknown }>();
      boundMethodsByClient.set(client, boundMethods);
    }
    // 同じクライアントの同じ関数を前回束ねていれば、その参照を使い回す (同一性を保つ)。
    // source も見るのは、テストがメソッドを差し替えたときに古い参照を返さないため
    const cached = boundMethods.get(property);
    if (cached && cached.source === value) return cached.bound;
    // 初回、または差し替えられていたら this が実クライアントを指すように束ね直す
    const bound = value.bind(client);
    // 次回同じプロパティを読んだときに同じ参照を返せるよう覚えておく
    boundMethods.set(property, { source: value, bound });
    // 束ね直したメソッドを返す
    return bound;
  },
  // プロパティ代入 (テストで $transaction を差し替える等) を実クライアントへ反映する
  set(_target, property, value) {
    return Reflect.set(getPrismaClient(), property, value);
  },
  // `in` 演算子やプロパティ存在確認も実クライアントに合わせる
  has(_target, property) {
    return Reflect.has(getPrismaClient(), property);
  },
  // Object.keys() / スプレッド展開が空にならないよう、キー一覧も実クライアントから返す
  ownKeys(_target) {
    return Reflect.ownKeys(getPrismaClient());
  },
  // ownKeys と対で必要 (記述子を返せないとキー列挙が実際には空になる)
  getOwnPropertyDescriptor(_target, property) {
    // 実クライアント側の記述子を取得する
    const descriptor = Reflect.getOwnPropertyDescriptor(getPrismaClient(), property);
    // Proxy の不変条件を満たすため、存在するキーは configurable: true にして返す
    return descriptor ? { ...descriptor, configurable: true } : undefined;
  },
  // Object.defineProperty での定義も実クライアントへ届ける (vitest がプロパティを差し替える経路)
  defineProperty(_target, property, descriptor) {
    return Reflect.defineProperty(getPrismaClient(), property, descriptor);
  },
  // Object.getPrototypeOf / instanceof が空ターゲット (素の Object) を見ないようにする
  getPrototypeOf(_target) {
    return Reflect.getPrototypeOf(getPrismaClient());
  },
  // プロトタイプの差し替えも実クライアントへ転送する (空ターゲットに書くと黙って消えるため)
  setPrototypeOf(_target, prototype) {
    return Reflect.setPrototypeOf(getPrismaClient(), prototype);
  },
  // 拡張の可否は「常に拡張できる」で答える (ownKeys が実クライアントのキーを返す以上、
  // ターゲットだけを非拡張にすると Proxy の不変条件に反して以降の Object.keys が TypeError になる)
  isExtensible() {
    return true;
  },
  // 凍結の要求は受け付けない (false を返すと呼び出し側が TypeError になり、黙って食い違うより分かる)
  preventExtensions() {
    return false;
  },
  // delete 演算子も実クライアントへ転送する
  deleteProperty(_target, property) {
    return Reflect.deleteProperty(getPrismaClient(), property);
  },
});
