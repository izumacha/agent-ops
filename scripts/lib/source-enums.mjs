// 「列挙の正本をソースから読む」読み取りだけを集めた共有モジュール。
//
// **なぜ共有するか**: ゲートは受け入れ基準の網羅を「一覧をゲートに書き写す」のではなく
// **正本から導いて**照合する (料金表からモデル名を導くのと同じ形。種別や理由を足した人が
// テストを書き忘れたら落ちる)。その読み取りを Step ごとのゲートに書き写すと、片方を直したときに
// もう片方が古い読み方のまま静かに残る (§6 DRY。`tests/lib/dependabot-config.ts` と同じ理由)。
//
// **読めなかったときは空配列を返す。** 例外にせず空で返すのは、呼び出し側 (ゲート) が
// 「1 件も読めなければ照合が空振りしている」として fail-closed で落とす形にそろえるため —
// 読み取りの失敗と「正本が空」を同じ 1 か所で落とせば、片方だけ扱いを忘れることが無い。
// 失敗の理由は握り潰さずその場でエラー出力へ残す (§6)。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Prisma スキーマ (enum の正本) の場所
const SCHEMA_PATH = join(process.cwd(), 'prisma', 'schema.prisma');

// 行末コメントを落として前後の空白を詰める (Prisma も TypeScript も `//` を使う)
function withoutLineComment(line) {
  // `//` から行末までを捨てる
  return line.replace(/\/\/.*$/, '').trim();
}

/**
 * Prisma スキーマの `enum <名前> { ... }` からメンバー名を読む。
 * **ドメイン側の TypeScript (`src/domain/types.ts`) とは tests/domain-enums.test.ts が一致を
 * 固定している**ので、どちらを読んでも同じ一覧になる (ゲートは TS を import できないので schema を読む)。
 * @param {string} label ログに出す呼び出し元の名前 (`gate:step4` など)
 * @param {string} enumName 読みたい enum の名前
 * @returns {string[]} メンバー名 (読めなければ空配列)
 */
export function readPrismaEnumMembers(label, enumName) {
  // スキーマを読む
  try {
    // ファイル全体
    const schema = readFileSync(SCHEMA_PATH, 'utf8');
    // 目的の enum のブロックを切り出す
    const block = new RegExp(`enum\\s+${enumName}\\s*\\{([^}]*)\\}`).exec(schema);
    // 見つからなければ空 (呼び出し側が fail-closed で落とす)
    if (block === null) return [];
    // 行ごとに、行末コメントを落として先頭の識別子だけを取る
    return block[1]
      .split('\n')
      .map(withoutLineComment)
      .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(line));
  } catch (error) {
    // 読めなかったことを残す (判定は空配列として落ちる)
    console.error(
      `[${label}] ${enumName} を prisma/schema.prisma から読めません:`,
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

/**
 * TypeScript の `export const <名前> = { キー: '値', … } as const;` から**値**を読む。
 *
 * **Prisma の enum ではない列挙もある** — 連鎖の壊れ方 (`AuditChainBreak`) は DB に保存しない
 * ドメインの語彙なので schema には無い。ゲートは TS を import できないのでソースを読む。
 * **値を読む**のは、テスト名に現れるのが値の綴りだから (キーと値が一致しない列挙でも効く)。
 * @param {string} label ログに出す呼び出し元の名前
 * @param {string} relativePath リポジトリ直下からの相対パス (例: `src/domain/audit/chain.ts`)
 * @param {string} constName 読みたい定数の名前
 * @returns {string[]} 文字列の値 (読めなければ空配列)
 */
export function readTsConstValues(label, relativePath, constName) {
  // ソースを読む
  try {
    // ファイル全体 (パスはリポジトリ直下からの相対)
    const source = readFileSync(join(process.cwd(), relativePath), 'utf8');
    // 目的の定数のブロックを切り出す (入れ子の `}` は持たない平坦な辞書だけを想定する)
    const block = new RegExp(`export const ${constName}\\s*=\\s*\\{([^}]*)\\}`).exec(source);
    // 見つからなければ空 (呼び出し側が fail-closed で落とす)
    if (block === null) return [];
    // 行ごとに `キー: '値',` の形から値だけを取る
    return block[1]
      .split('\n')
      .map(withoutLineComment)
      .map((line) => /^[A-Za-z_][A-Za-z0-9_]*\s*:\s*['"]([^'"]+)['"]/.exec(line))
      .filter((matched) => matched !== null)
      .map((matched) => matched[1]);
  } catch (error) {
    // 読めなかったことを残す
    console.error(
      `[${label}] ${constName} を ${relativePath} から読めません:`,
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}
