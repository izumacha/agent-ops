// `.github/dependabot.yml` の読み方を 1 か所に集める。
//
// **写しを持たない理由**: 保留を見張る検査は依存ごとに 1 本ずつ増える (現在は eslint と typescript)。
// 「npm ブロックをどう選ぶか」「ignore をどう取り出すか」をテストごとに書き写すと、
// 設定の書き方が変わったとき (`directories:` の複数形・glob、`dependency-name` のワイルドカード等) に
// **片方だけが直り、もう片方の検出網が古い読み方のまま静かに残る** (§6 DRY)。
// 姉妹リポジトリ (my-first-ai-app / helpdesk-hub) も同じ形で集約している。
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
 * npm エコシステム (ルートディレクトリ) の `ignore` 一覧を返す。
 *
 * ブロックがちょうど 1 つあることを確かめてから読むので、**別ディレクトリ・別エコシステムへの
 * 置き間違い**（保留を書いたつもりで一度も効かない形）はここで落ちる。
 * 見つからない・2 つある場合は例外にして fail-closed にする — 空配列を返すと
 * 「保留が無い」と「読めなかった」が区別できず、呼び出し側の検査が誤った理由で落ちる。
 */
export function npmIgnores(): IgnoreEntry[] {
  // 設定を読む
  const config = parse(readFileSync(join(ROOT, '.github', 'dependabot.yml'), 'utf8')) as {
    updates: UpdateBlock[];
  };
  // npm エコシステムでルートディレクトリのブロックを探す
  const npm = config.updates.filter((u) => u['package-ecosystem'] === 'npm' && u.directory === '/');
  // ちょうど 1 つあること (0 件 = 置き間違い、2 件以上 = どちらが効くか読めない)
  if (npm.length !== 1) {
    throw new Error(
      `dependabot.yml の npm (directory: '/') ブロックがちょうど 1 つではない (${npm.length} 件)`,
    );
  }
  // ignore 一覧を返す (無ければ空)
  return npm[0].ignore ?? [];
}

/**
 * 「その依存の major **だけ**を止めるエントリがちょうど 1 つある」ことを確かめ、そのエントリを返す。
 *
 * 3 つの壊れ方をまとめて落とす:
 *   - **消失** … エントリが無い（保留が外れて major 更新の PR が立つ）
 *   - **重複** … 同じ依存のエントリが 2 つ以上（Dependabot は複数エントリを**すべて**適用するので効きすぎる）
 *   - **効きすぎ** … `update-types` の欠落（= 全バージョン無視で minor / patch まで止まる）・`versions` の追加
 */
export function majorOnlyIgnore(dependencyName: string): IgnoreEntry {
  // その依存を対象にするエントリ
  const entries = npmIgnores().filter((e) => e['dependency-name'] === dependencyName);
  // 1 つだけであること
  if (entries.length !== 1) {
    throw new Error(
      `${dependencyName} の ignore エントリがちょうど 1 つではない (${entries.length} 件)`,
    );
  }
  // 見つかったエントリ
  return entries[0];
}
