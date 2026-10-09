// 層の向き（ADR-0006）を**散文ではなく機械で**見張る検査。
//
// `src/domain` は「DB も Next.js も知らない純粋なビジネスルール」の層で、`src/lib`（横断の
// インフラ）へは依存しない向きになっている。ところが ADR-0014 で 1 本だけ例外を作った
// （`src/domain/plan.ts` が未知のプランを黙って倒さないために `@/lib/log` を取り込む）。
// あのとき決めたのは「**これ以上増やさない**」だが、**その決定は文章にしか無かった** ——
// 2 本目を足しても何も落ちない。ここで理由付きの表と突き合わせる。
//
// あわせて、その例外が持ち込んだ**副作用の範囲**も見張る。`@/lib/log` → `@/lib/metrics` の
// 連鎖はモジュール評価時に `process.uptime()` を読むので、この連鎖へ到達するモジュールは
// サーバー専用になる。`'use client'` のモジュールから到達すると**ブラウザで評価時に壊れる**
// （`process.uptime is not a function`）。しかも壊れるのは実行時で、lint も typecheck も
// 通ってしまう。
import { describe, expect, it } from 'vitest';
import { basename, join, relative } from 'node:path';
import {
  SRC_DIR,
  declaresDirective,
  parseSourceFiles,
  sourceImportGraph,
} from './lib/source-files';

// 走査結果はモジュール評価時に 1 度だけ作って使い回す
const PARSED = parseSourceFiles();
// import の連鎖（ファイル → 取り込み先）
const GRAPH = sourceImportGraph(PARSED);

// 純粋な層（ここから下の層へは依存しない）
const DOMAIN_DIR = join(SRC_DIR, 'domain');
// 横断のインフラの層
const LIB_DIR = join(SRC_DIR, 'lib');
// モジュール評価時に Node.js だけの API を読むので、ブラウザへ持ち込めないモジュール
const SERVER_ONLY_MODULE = join(LIB_DIR, 'metrics.ts');

/**
 * `src/domain` から `src/lib` を取り込んでよいファイルと、その理由。
 *
 * **エントリが増える差分は、理由の妥当性をレビューで必ず確認する**（このリポジトリが
 * 繰り返し「静かに緩む口」と記録している除外表と同じ扱い）。鍵は `src/` からの相対パス。
 */
const DOMAIN_TO_LIB_EXCEPTIONS: Readonly<Record<string, string>> = {
  'domain/plan.ts':
    '未知のプランを最も厳しい側へ倒すとき、黙って倒れないようサーバログへ 1 行残す（ADR-0014 の「影響」。代替案は Port 経由と呼び出し側での記録で、前者は 1 イベントのために層を 1 枚増やし、後者は 5 か所の呼び出し側に写しを作る）',
};

// `'use server'` を宣言しているモジュール（ここはクライアントの束に入らない境界）
const SERVER_BOUNDARIES = new Set(
  PARSED.filter((parsed) => declaresDirective(parsed, 'use server')).map((parsed) => parsed.path),
);

/**
 * クライアントの束に実際に入る範囲だけを辿って、目的のモジュールへ到達するかを返す。
 *
 * **`'use server'` のモジュールの先へは進まない。** Client Component が Server Action を
 * `import` するのは普通の書き方だが、バンドラがクライアントへ入れるのは**参照**だけで本体は
 * サーバーに残る。進んでしまうと、ログインのフォームが自分の Server Action を取り込んでいる
 * だけで違反として名指しされ、案内できる直し方が無くなる（実測で 3 つのフォームすべてが
 * そうなった）。
 * @param entry 起点の絶対パス
 * @param target 到達を調べる絶対パス
 * @returns 到達すれば true
 */
function reachesInClientBundle(entry: string, target: string): boolean {
  // 訪問済み（循環 import で止まらなくならないように）
  const seen = new Set<string>();
  // 未訪問の積み
  const stack = [entry];
  // 深さ優先で辿る
  while (stack.length > 0) {
    // 次に見るファイル
    const current = stack.pop() as string;
    // すでに見たら飛ばす
    if (seen.has(current)) continue;
    seen.add(current);
    // 目的地に着いた（起点そのものは数えない）
    if (current === target && current !== entry) return true;
    // サーバー側の境界（起点自身は除く）より先はクライアントの束に入らない
    if (current !== entry && SERVER_BOUNDARIES.has(current)) continue;
    // 取り込み先を積む
    stack.push(...(GRAPH.get(current) ?? []));
  }
  // 辿り切っても着かなかった
  return false;
}

describe('層の向き（ADR-0006 / ADR-0014）', () => {
  it('src/domain から src/lib を取り込むのは理由付きの表に載せたファイルだけ', () => {
    // domain 配下のファイルごとに、lib 配下への直接の取り込みを集める
    const offenders = PARSED.filter((parsed) => parsed.path.startsWith(`${DOMAIN_DIR}/`))
      .filter((parsed) => (GRAPH.get(parsed.path) ?? []).some((to) => to.startsWith(`${LIB_DIR}/`)))
      .map((parsed) => relative(SRC_DIR, parsed.path))
      // 表に載っているものは許す
      .filter((key) => DOMAIN_TO_LIB_EXCEPTIONS[key] === undefined);
    // 表に無い依存は落とす（2 本目を足すときは理由を書いてレビューを通す）
    expect(offenders).toEqual([]);
  });

  it('表に載っているファイルは実在し、理由が空でない', () => {
    // 表の鍵ごとに「実在するか」と「実際に lib を取り込んでいるか」を確かめる
    for (const [key, reason] of Object.entries(DOMAIN_TO_LIB_EXCEPTIONS)) {
      // 理由が空の登録（登録するだけで黙らせる形）を許さない
      expect(reason.trim(), `${key} の理由`).not.toBe('');
      // そのファイルの取り込み先
      const imports = GRAPH.get(join(SRC_DIR, key));
      // 実在しない鍵は表の掃除漏れ（依存が消えたのに登録が残っている）
      expect(imports, `${key} が実在する`).toBeDefined();
      // 実際に lib を取り込んでいない鍵も掃除漏れ
      expect(
        (imports ?? []).some((to) => to.startsWith(`${LIB_DIR}/`)),
        `${key} は実際に src/lib を取り込んでいる`,
      ).toBe(true);
    }
  });

  it("'use client' のモジュールはサーバー専用のモジュールへ到達しない", () => {
    // ディレクティブを宣言しているファイル
    const clientModules = PARSED.filter((parsed) => declaresDirective(parsed, 'use client'));
    // 1 つも拾えなければ検査が死んでいる（fail-closed。実際に 3 つある）
    expect(clientModules.length, "'use client' のモジュールを拾えている").toBeGreaterThan(0);
    // 到達してしまうものを集める
    const reaching = clientModules
      .filter((parsed) => reachesInClientBundle(parsed.path, SERVER_ONLY_MODULE))
      .map((parsed) => relative(SRC_DIR, parsed.path));
    // 1 つでもあればブラウザで評価時に壊れる
    expect(reaching).toEqual([]);
  });

  it('サーバー専用と見なしているモジュールは実際に Node.js だけの API を読む', () => {
    // 上の検査が指している先が実在すること（名前を変えたときに黙って空振りしない）
    const parsed = PARSED.find((candidate) => candidate.path === SERVER_ONLY_MODULE);
    expect(parsed, `${basename(SERVER_ONLY_MODULE)} が実在する`).toBeDefined();
    // モジュール評価時に読む Node.js だけの API（ブラウザには無い）
    expect(parsed?.source.text).toContain('process.uptime()');
  });
});
