// Prisma 7 で必須になったドライバアダプタ (node-postgres 版) をインポート
import { PrismaPg } from '@prisma/adapter-pg';
// 生成された Prisma クライアント本体と、ログ設定の型をインポート
import { Prisma, PrismaClient } from '@/generated/prisma';
// 接続時に search_path を固定する libpq オプションの組み立て (純粋関数)
import { buildSearchPathOption } from './pg-search-path';
// 生 SQL をパラメータ化された形だけに閉じる実行時ガード
import { guardRawSql } from './raw-sql-guard';

// `?schema=` が書かれていないときに使うスキーマ。Prisma 5 のクエリエンジンは接続時に search_path を
// ここへ固定していたが、Prisma 7 のドライバアダプタは何もしない。既定値を明示して
// 「ORM は public、生 SQL はサーバ側の search_path」という食い違いを防ぐ
const DEFAULT_SCHEMA = 'public';

// Prisma 5 のクエリエンジンが持っていた既定の待ち時間 (秒)。
// node-postgres は既定で「無期限に待つ」ため、そのままだと DB 到達不能がエラーではなくハングになる
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;

// 接続文字列を URL として解釈する (壊れた URL は資格情報を伏せて落とす)
function parseConnectionString(connectionString: string): URL {
  // URL として解釈を試みる
  try {
    // 解釈できたらそのまま返す
    return new URL(connectionString);
  } catch {
    // 元の TypeError は input プロパティに DSN 全体 (パスワード込み) を載せるため、
    // そのまま投げるとログに資格情報が残る。文脈だけを伝える例外に差し替える
    throw new Error(
      'DATABASE_URL を URL として解釈できません。postgresql://... 形式で指定してください (値はログに出しません)。',
    );
  }
}

/**
 * schema 指定つき DSN 用の接続設定を組み立てる。
 * node-postgres は DSN が持つ `options=` を設定オブジェクトの上に重ねるため、DSN 側に options が
 * あると search_path の固定が黙って上書きされる (Neon の `?options=endpoint%3D...` 等)。
 * 両方を結合し、search_path を後ろに置いて必ず効かせ、DSN 側からは options を取り除く。
 */
// schema 指定つき DSN 用の接続設定を組み立てる (DSN 側の options と併存させる)。
// export しているのはテストから直接確かめるため — この合流 (DSN 側 options と search_path) は
// CI の接続先が options を持たないので、実際の接続経路では一度も通らない
export function buildScopedConnectionConfig(
  connectionString: string,
  url: URL,
  schema: string,
): { connectionString: string; options: string } {
  // search_path を固定する接続時オプションを作る (空のスキーマ名はここで弾かれる)
  const searchPathOption = buildSearchPathOption(schema);
  // DSN が独自の options を持っているか調べる
  const dsnOptions = url.searchParams.get('options');
  // 持っていなければ、接続文字列はそのまま使い options だけを足す (再エンコードを避ける)
  if (dsnOptions === null) return { connectionString, options: searchPathOption };
  // 持っている場合は、後勝ちで上書きされないよう DSN 側から options を取り除く
  const withoutOptions = new URL(url);
  withoutOptions.searchParams.delete('options');
  // DSN の指定を活かしつつ、search_path は後ろに置いて必ず効かせる
  return {
    connectionString: withoutOptions.toString(),
    options: `${dsnOptions} ${searchPathOption}`,
  };
}

/**
 * PrismaClient を生成する共通ファクトリ。
 * Prisma 7 は datasource.url を schema.prisma に書けないため、接続文字列は毎回ここで結線する。
 * アプリの singleton (src/lib/prisma.ts)・seed・契約テストはすべてこれを経由する (結線を 1 か所に集める)。
 */
// PrismaClient を生成する共通ファクトリ (ログ設定だけ呼び出し側が指定できる)
export function createPrismaClient(options?: {
  // Prisma が出力するログの種類 (省略時は Prisma の既定に任せる)
  log?: (Prisma.LogLevel | Prisma.LogDefinition)[];
}): PrismaClient {
  // 接続文字列を環境変数から取り出す
  const connectionString = process.env.DATABASE_URL;

  // 接続文字列が無いまま進むと実行時まで気付けないので、ここで明示的に落とす (fail-closed)
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL が未設定です。Prisma 7 はドライバアダプタ経由で接続するため、接続文字列が必須です。',
    );
  }

  // 接続文字列を 1 度だけ解釈する (schema と options をここから取り出す)
  const url = parseConnectionString(connectionString);
  // Prisma CLI (migrate) は `?schema=` を解釈してそのスキーマにテーブルを作るが、ドライバアダプタは
  // 素通しする。取りこぼすと CLI と実行時クライアントが別スキーマを向き、ヘルスチェック (SELECT 1) は
  // 通るのに全クエリが「relation does not exist」になる。ここで取り出して adapter の schema と
  // 接続時の search_path の両方へ反映する。**未指定は public を明示し、空文字は弾く**
  // (`?schema=` と値だけ空の状態を既定へ倒すと、テンプレートの変数が空のまま展開された事故に気付けない)
  const schema = url.searchParams.get('schema') ?? DEFAULT_SCHEMA;

  // node-postgres のコネクションプールを内部に持つアダプタを組み立てる。
  // Prisma が組み立てるクエリは schema オプションで、生 SQL は接続時の search_path で同じスキーマへ向ける
  const adapter = new PrismaPg(
    {
      // 接続先 (search_path の固定オプション込み)
      ...buildScopedConnectionConfig(connectionString, url, schema),
      // 接続確立の上限 (ミリ秒)。無期限待ちを避ける。
      // **この行に検出網は無い** — 外しても全テストが緑のまま通る (実測)。外すと DB 到達不能時に
      // /health が 503 を返さずハングし、compose や k8s の生存確認が「応答なし」になる。
      // アダプタの設定は組み立てて即座に new へ渡すので値を取り出して検査できない。レビューで守る
      connectionTimeoutMillis: DEFAULT_CONNECT_TIMEOUT_SECONDS * 1000,
    },
    {
      // Prisma が生成するクエリの修飾に使うスキーマ
      schema,
      // プールや待機中コネクションのエラーを握り潰さない (接続文字列を含まない安全なメッセージだけ残す)
      onPoolError: (error: Error) => console.error('[prisma] 接続プールでエラー:', error.message),
      onConnectionError: (error: Error) =>
        console.error('[prisma] コネクションでエラー:', error.message),
    },
  );

  // アダプタを渡して PrismaClient を生成する
  const client = new PrismaClient({ adapter, ...(options?.log ? { log: options.log } : {}) });
  // 生 SQL の危険な使い方を実行時に閉じてから返す (綴りを追う静的検査は 1 段の間接化で崩れるため、
  // 値そのものを見るここが本体。アプリ・seed・契約テスト・CLI はすべてこのファクトリを通る)
  return guardRawSql(client);
}
