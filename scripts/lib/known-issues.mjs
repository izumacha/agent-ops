// Step7 の受け入れ基準④「既知バグ 0（Issue 管理）」の**材料を集める側**。
// 判定そのものは `scripts/lib/gate-report.mjs` の `knownBugProblems`（純粋関数）が持つ
// ——「測る側は出すだけ、合否はゲートが決める」という既存の分担（ベンチ・Lighthouse と同じ）。
//
// **手がかりを 2 つに分ける.** GitHub の Issue はゲートから読めない（ネットワークに出られない）ので、
//   (a) 文書（`docs/known-issues.md`）の表が空であること
//   (b) ソースに「いま壊れていると分かっている」印が残っていないこと
// の両方を見る。文書だけを見ると編集 1 行で黙らせられ、印だけを見ると文書に書いた未解決のバグが
// 素通りする（どちらも片方だけでは fail-open）。
//
// **印の綴りをこのファイルのコメントに書かない.** 走査は「コメントの中にその綴りがある行」を
// 拾うので、説明のためにコメントへ綴りを書くと**この検出網が自分自身を報告する**。
// 一覧の正本は `scripts/lib/step7-criteria.mjs` の配列（コメントではなく値として持つ）。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  KNOWN_BUG_MARKERS,
  KNOWN_BUG_MARKER_DIRS,
  KNOWN_BUG_MARKER_EXCLUDED_DIRS,
  KNOWN_ISSUES_DOC,
  KNOWN_ISSUES_HEADING,
} from './step7-criteria.mjs';

// 走査する拡張子（コメントを書ける形式だけ。画像・ロックファイル等は読まない）
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx', '.prisma', '.sql'];
// 行末までコメントになる綴り（`--` は SQL。マイグレーションは `.sql` なので要る）
const LINE_COMMENT_OPENERS = ['//', '#', '--'];
// 囲むコメントの開き・閉じ（**行をまたぐので状態を持って追う** — 中の行に `*` が無くても
// コメントであることは変わらない。印を書く人が整形の慣習に従う前提を置かない）
const BLOCK_COMMENT_OPEN = '/*';
const BLOCK_COMMENT_CLOSE = '*/';
// Markdown の表の行の始まり
const TABLE_ROW_PREFIX = '|';
// Markdown の見出しの始まり（節の終わりを見つけるのに使う）
const HEADING_PREFIX = '##';
// 表の形として最低限必要な行数（見出し行 ＋ 区切り行）
const TABLE_FRAME_ROWS = 2;

/**
 * 既知の問題の文書を読み、**未解決として書かれている行**と構造の問題を返す。
 *
 * 期待する形: `## 未解決のバグ` の節に Markdown の表があり、見出し行と区切り行だけ（＝データ行が
 * 0 件）であること。**表の枠そのものを要求する**のが要点で、節を空にして枠ごと消す形は
 * 「読めない」として落とす（fail-closed。枠が無いと「0 件」と「書き方が変わった」を区別できない）。
 *
 * @param {string} [root] 読む基点（既定はリポジトリのルート。テストが差し替えるために受け取る）
 * @returns {{ openIssues: string[]; docProblems: string[] }} 未解決の行と、構造の問題
 */
export function readKnownIssues(root = process.cwd()) {
  // 構造の問題（1 つでもあれば判定側が落とす）
  const docProblems = [];
  // 文書の中身
  let text;
  // 読めなければそこで終わり（fail-closed）
  try {
    text = readFileSync(join(root, KNOWN_ISSUES_DOC), 'utf8');
  } catch {
    docProblems.push(`${KNOWN_ISSUES_DOC} を読めません`);
    return { openIssues: [], docProblems };
  }
  // 行に割る
  const lines = text.split('\n');
  // 見出しの位置
  const headingIndex = lines.findIndex((line) => line.trim() === KNOWN_ISSUES_HEADING);
  // 見出しが無ければ照合できない
  if (headingIndex < 0) {
    docProblems.push(`${KNOWN_ISSUES_DOC} に見出し「${KNOWN_ISSUES_HEADING}」がありません`);
    return { openIssues: [], docProblems };
  }
  // 節の終わり（次の見出し、または文書の終わり）
  const after = lines.slice(headingIndex + 1);
  const nextHeading = after.findIndex((line) => line.trimStart().startsWith(HEADING_PREFIX));
  const section = nextHeading < 0 ? after : after.slice(0, nextHeading);
  // 節の中の表の行
  const rows = section.filter((line) => line.trimStart().startsWith(TABLE_ROW_PREFIX));
  // 枠（見出し行 ＋ 区切り行）が無ければ「0 件」と言い切れない
  if (rows.length < TABLE_FRAME_ROWS) {
    docProblems.push(
      `${KNOWN_ISSUES_DOC} の「${KNOWN_ISSUES_HEADING}」に表の枠（見出し行と区切り行）がありません`,
    );
    return { openIssues: [], docProblems };
  }
  // 枠より後ろの行が未解決のバグ
  return { openIssues: rows.slice(TABLE_FRAME_ROWS).map((line) => line.trim()), docProblems };
}

/**
 * その行のどの位置がコメントの中かを求める（行をまたぐ囲みコメントの状態も返す）。
 *
 * **コードの中の値（印の一覧そのもの）を拾わないため**の絞り込み。実際の「未解決の欠陥」の印は
 * 必ずコメントに書かれるので、これで取り落としは起きない。
 *
 * **「印より手前にコメントの開きがあるか」だけを見る形では足りなかった**（実測）:
 * SQL の `--` を見ていなかったのでマイグレーションのコメントが素通りし、囲みコメントの
 * 2 行目以降は行頭に `*` を書く整形の慣習に頼っていたので、`*` の無い行が素通りした。
 * 状態を持って 1 文字ずつ見れば、どちらも同じ 1 つの規則で閉じる。
 *
 * **文字列リテラルの中は区別しない**（`'…//…'` の後ろはコメント扱いになる）。
 * 見逃すより余計に拾うほうが安全側で、印の綴りをたまたま含む文字列は実在しない。
 * @param {string} line 1 行
 * @param {boolean} startedInBlock その行が囲みコメントの途中から始まるか
 * @returns {{ flags: boolean[]; endsInBlock: boolean }} 位置ごとの可否と、行末の状態
 */
export function commentPositions(line, startedInBlock) {
  // 位置ごとに「コメントの中か」を持つ
  const flags = new Array(line.length).fill(false);
  // 囲みコメントの中にいるか
  let block = startedInBlock;
  // 行末までのコメントに入ったか
  let lineComment = false;
  // 1 文字ずつ見る
  for (let index = 0; index < line.length; index += 1) {
    // 囲みコメントの中なら、閉じを見つけるまで全部コメント
    if (block) {
      flags[index] = true;
      // 閉じなら 2 文字ぶん消費して外へ出る
      if (line.startsWith(BLOCK_COMMENT_CLOSE, index)) {
        flags[index + 1] = true;
        block = false;
        index += 1;
      }
      continue;
    }
    // 行末までのコメントに入っていれば、残りは全部コメント
    if (lineComment) {
      flags[index] = true;
      continue;
    }
    // 囲みコメントの開き
    if (line.startsWith(BLOCK_COMMENT_OPEN, index)) {
      block = true;
      flags[index] = true;
      flags[index + 1] = true;
      index += 1;
      continue;
    }
    // 行末までのコメントの開き
    if (LINE_COMMENT_OPENERS.some((opener) => line.startsWith(opener, index))) {
      lineComment = true;
      flags[index] = true;
      continue;
    }
  }
  // 位置ごとの可否と、次の行へ持ち越す状態
  return { flags, endsInBlock: block };
}

/**
 * そのディレクトリ以下のファイルを再帰で集める（走査対象の拡張子だけ）。
 *
 * **生成物のディレクトリは掘らない**（`KNOWN_BUG_MARKER_EXCLUDED_DIRS`）。理由はそちらに書いた。
 * @param {string} directory 掘る場所（絶対パス）
 * @param {Set<string>} excluded 掘らない場所（絶対パス）
 * @returns {string[]} 見つかったファイル（絶対パス）
 */
function filesUnder(directory, excluded) {
  // 集めたパス
  const found = [];
  // 除外されていれば掘らない
  if (excluded.has(directory)) return found;
  // 読めなければ空（呼び出し側が「1 件も読めない」として落とす）
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  // 1 つずつ見る
  for (const entry of entries) {
    // フルパス
    const path = join(directory, entry.name);
    // ディレクトリなら掘る
    if (entry.isDirectory()) {
      found.push(...filesUnder(path, excluded));
      continue;
    }
    // 走査対象の拡張子だけ
    if (SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) found.push(path);
  }
  // 集めたパス
  return found;
}

/**
 * ソースのコメントに残った「未解決の欠陥」の印を探す。
 *
 * @param {string} [root] 走査の基点（既定はリポジトリのルート。テストが差し替えるために受け取る）
 * @returns {{ hits: string[]; scannedFiles: number }} 見つかった印（`<パス>:<行> <印>`）と走査したファイル数
 */
export function findKnownBugMarkers(root = process.cwd()) {
  // 見つかった印
  const hits = [];
  // 走査したファイル数（0 件なら判定側が fail-closed で落とす）
  let scannedFiles = 0;
  // 掘らない場所（絶対パスにしてから渡す）
  const excluded = new Set(
    Object.keys(KNOWN_BUG_MARKER_EXCLUDED_DIRS).map((relative) => join(root, relative)),
  );
  // 対象のディレクトリ以下のファイルを順に見る
  for (const path of KNOWN_BUG_MARKER_DIRS.flatMap((directory) =>
    filesUnder(join(root, directory), excluded),
  )) {
    // リポジトリ相対のパス（出力が機械に依存しないように）
    const name = path.slice(root.length + 1);
    // 読めなければ飛ばす（走査数にも数えない）
    let lines;
    try {
      lines = readFileSync(path, 'utf8').split('\n');
    } catch {
      continue;
    }
    scannedFiles += 1;
    // 囲みコメントは行をまたぐので状態を持ち越す
    let inBlock = false;
    // 行ごとに印を探す
    lines.forEach((line, offset) => {
      // この行のどこがコメントかを求める
      const { flags, endsInBlock } = commentPositions(line, inBlock);
      // 次の行へ状態を持ち越す
      inBlock = endsInBlock;
      // 印を 1 つずつ当てる
      for (const marker of KNOWN_BUG_MARKERS) {
        // その行での位置
        const index = line.indexOf(marker);
        // 無ければ次の印
        if (index < 0) continue;
        // コメントの中だけを拾う（コードの中の値は対象外）
        if (flags[index] !== true) continue;
        // リポジトリ相対のパスで覚える（出力が機械に依存しないように）
        hits.push(`${name}:${offset + 1} ${marker}`);
      }
    });
  }
  // 見つかった印と走査数
  return { hits, scannedFiles };
}
