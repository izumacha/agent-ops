// PostgreSQL の接続時オプション (libpq の `options` パラメータ) を組み立てる純粋関数。
// Prisma に依存しないので、ユニットテストからそのまま呼べる (DB も不要)。

/**
 * Builds the libpq `options` value that pins a connection's `search_path`.
 *
 * Why this is needed at all: the Prisma driver adapter's `schema` option only
 * qualifies the queries Prisma generates. Raw SQL (`$queryRaw` /
 * `$executeRawUnsafe`) still resolves through `search_path`, so without this
 * the two halves would silently target different schemas.
 *
 * Why it is built by hand: `search_path` cannot be set with a bind parameter
 * (`SET` takes no placeholders), and node-postgres has no hook that runs — and
 * is awaited — before a freshly opened pooled connection is handed out, so a
 * `SELECT set_config(...)` after connect would race the first query. The
 * startup option is applied by the server before any query runs.
 *
 * Two layers of quoting are therefore required, in this order:
 *   1. GUC value: wrap the name in double quotes so hyphens, spaces, upper case
 *      and reserved words survive. This also stops a name from being read as a
 *      comma-separated list, i.e. from appending extra schemas. Embedded double
 *      quotes are doubled as PostgreSQL requires — names carrying one are
 *      rejected above, but the escaping stays correct on its own so this
 *      builder cannot become an injection point if that guard ever moves.
 *   2. libpq `options`: escape backslashes and spaces, which are consumed as
 *      separators/escapes before the value reaches the GUC. Other whitespace
 *      cannot be escaped this way and is rejected above.
 */
// 接続時に search_path を固定する libpq options 文字列を組み立てる
export function buildSearchPathOption(schema: string): string {
  // 空文字は search_path として意味を成さない (どのスキーマも指さない) ので弾く
  if (schema.length === 0) {
    throw new Error('DATABASE_URL の ?schema= が空です。スキーマ名を指定してください。');
  }
  // 空白以外の空白文字 (タブ・改行など) は救えないので入口で弾く (fail-closed)。
  // 半角スペースはバックスラッシュで退避すればサーバ側の分割を生き延びるが、タブや改行は
  // サーバの pg_split_opts がそのまま区切りとして扱い、options 文字列が途中で割れる
  // (実測: `?schema=tab<TAB>here` は接続時に 22023 の分かりにくいエラーになる)。
  if (/[^\S ]/.test(schema)) {
    throw new Error(
      'DATABASE_URL の ?schema= に使える空白文字は半角スペースだけです (タブ・改行は指定できません)。',
    );
  }
  // 二重引用符を含む名前は**この関数だけでは救えない**ので入口で弾く (fail-closed)。
  // search_path 側は下の引用で正しく扱えるが、Prisma のドライバアダプタが生成する
  // SQL (`"スキーマ"."テーブル"`) はスキーマ名の " をエスケープしないため、
  // 通してしまうと ORM のクエリだけが構文エラーになる (実 DB で確認済み)。
  if (schema.includes('"')) {
    throw new Error(
      'DATABASE_URL の ?schema= に二重引用符は使えません (Prisma がクエリ生成時にエスケープしないため)。',
    );
  }
  // (1) GUC 値としての引用: 埋め込まれた " を "" に増やしてから全体を " で囲む
  const quotedIdentifier = `"${schema.replace(/"/g, '""')}"`;
  // (2) libpq の options としての引用: libpq が食べてしまう \ と空白を \ で退避する
  const escapedForLibpq = quotedIdentifier.replace(/[\\ ]/g, (character) => `\\${character}`);
  // 接続確立時に適用される設定として返す
  return `-c search_path=${escapedForLibpq}`;
}
