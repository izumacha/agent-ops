// `.github/dependabot.yml` の読み方を 1 か所に集める。
//
// **写しを持たない理由**: 保留を見張る検査は依存ごとに 1 本ずつ増える (現在は eslint / typescript /
// `@types/node` / docker の `node`)。「どのブロックを選ぶか」「ignore をどう取り出すか」を
// テストごとに書き写すと、設定の書き方が変わったとき (`directories:` の複数形・glob、
// `dependency-name` のワイルドカード等) に **片方だけが直り、もう片方の検出網が古い読み方のまま
// 静かに残る** (§6 DRY)。姉妹リポジトリ (my-first-ai-app / helpdesk-hub) も同じ形で集約している。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

// リポジトリのルート (テストは常にルートから実行される)
const ROOT = process.cwd();

/** `ignore` エントリ 1 件分 (Dependabot の設定に現れる形)。 */
export interface IgnoreEntry {
  'dependency-name': string;
  'update-types'?: string[];
  versions?: string[];
}

// 設定ファイルの更新ブロック 1 件分 (読むのに要る項目だけ)
interface UpdateBlock {
  'package-ecosystem': string;
  directory: string;
  ignore?: IgnoreEntry[];
}

/**
 * 指定したエコシステム (ルートディレクトリ) の `ignore` 一覧を返す。
 *
 * ブロックがちょうど 1 つあることを確かめてから読むので、**別ディレクトリ・別エコシステムへの
 * 置き間違い**（保留を書いたつもりで一度も効かない形）はここで落ちる。
 * 見つからない・2 つある場合は例外にして fail-closed にする — 空配列を返すと
 * 「保留が無い」と「読めなかった」が区別できず、呼び出し側の検査が誤った理由で落ちる。
 *
 * **export しない。** 生の一覧を直接読めるようにすると、将来のガードが
 * {@link majorOnlyIgnore} の消失・重複・効きすぎの検査を迂回できてしまい、
 * このファイルを切り出した目的（読み方も判定も 1 か所）と逆になる。
 */
function ignoresFor(ecosystem: string): IgnoreEntry[] {
  // 設定を読む
  const config = parse(readFileSync(join(ROOT, '.github', 'dependabot.yml'), 'utf8')) as {
    updates: UpdateBlock[];
  };
  // そのエコシステムでルートディレクトリのブロックを探す
  const blocks = config.updates.filter(
    (u) => u['package-ecosystem'] === ecosystem && u.directory === '/',
  );
  // ちょうど 1 つあること (0 件 = 置き間違い、2 件以上 = どちらが効くか読めない)
  if (blocks.length !== 1) {
    throw new Error(
      `dependabot.yml の ${ecosystem} (directory: '/') ブロックがちょうど 1 つではない (${blocks.length} 件)`,
    );
  }
  // ignore 一覧を返す (無ければ空)
  return blocks[0].ignore ?? [];
}

/**
 * `dependency-name` がその依存に当たるか。
 *
 * **完全一致だけで照合しない。** Dependabot は `dependency-name` の `*` をワイルドカードとして
 * 解釈するので、完全一致のエントリの横に `- dependency-name: 'eslint*'` ＋ `versions: ['>=0']`
 * を**併記**すると、実際には両方が適用されて minor / patch（セキュリティ修正を含む）まで
 * 黙って止まる。完全一致だけで数えると件数は 1 のままで、下の「重複・効きすぎ」の検査が
 * 素通りする（fail-open）。ワイルドカード単独の場合は 0 件になって例外へ倒れるので、
 * 閉じていなかったのは**開く側**だけ。
 */
function matchesDependency(pattern: string, dependencyName: string): boolean {
  // ワイルドカードが無ければ完全一致
  if (!pattern.includes('*')) return pattern === dependencyName;
  // `*` 以外は正規表現のメタ文字として扱わない (綴りをそのまま照合する)
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) =>
    char === '*' ? '.*' : `\\${char}`,
  );
  // 全体一致で判定する
  return new RegExp(`^${escaped}$`).test(dependencyName);
}

/**
 * 「その依存の major **だけ**を止めるエントリがちょうど 1 つある」ことを確かめ、そのエントリを返す。
 *
 * 3 つの壊れ方をまとめて落とす:
 *   - **消失** … エントリが無い（保留が外れて major 更新の PR が立つ）
 *   - **重複** … その依存に当たるエントリが 2 つ以上（Dependabot は複数エントリを**すべて**適用する）
 *   - **効きすぎ** … `update-types` の欠落（= 全バージョン無視で minor / patch まで止まる）・`versions` の追加
 */
export function majorOnlyIgnore(dependencyName: string, ecosystem = 'npm'): IgnoreEntry {
  // その依存に当たるエントリ (ワイルドカードのものも含む)
  const entries = ignoresFor(ecosystem).filter((e) =>
    matchesDependency(e['dependency-name'], dependencyName),
  );
  // 1 つだけであること
  if (entries.length !== 1) {
    throw new Error(
      `${ecosystem} の ${dependencyName} に当たる ignore エントリがちょうど 1 つではない (${entries.length} 件)`,
    );
  }
  // 見つかったエントリ
  return entries[0];
}
