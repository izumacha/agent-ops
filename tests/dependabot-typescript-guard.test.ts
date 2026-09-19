// TypeScript の major 更新を保留していることと、その保留の期限切れを見張る。
//
// **なぜ止めるか**: lint の経路に載る `typescript-eslint` / `@typescript-eslint/*` は peer で
// `typescript >=4.8.4 <6.1.0` を宣言しており、型生成に使う `openapi-typescript` は `^5.x`。
// TypeScript 7 を入れると `npm ci` が ERESOLVE で落ちるため、CI はインストールの時点で赤になる
// (実測: Dependabot の PR #2 は 3 ジョブすべてが `npm ci` の ERESOLVE で失敗した)。
// **解除条件は「必須 peer を宣言している依存が揃って次の major を許すこと」**で、それはこのテストが
// ロックファイルから導いて判定する。**落ちたら自動的に削除してよいわけではない** —
// `ignore` はすべての major を止めているので、次の major だけが通るようになった状態で消すと
// さらに上の major が入って同じ ERESOLVE が戻る。失敗文言が上の major の状況まで出すので、
// 「削除する」か「`versions` で範囲を絞る」かを見て決めること。
//
// **見張る対象を手書きの一覧にしない。** 「どの依存が TypeScript の版を縛っているか」は
// ロックファイルに構造として現れるので、そこから導けば依存が増減しても一覧が古くならない
// (このリポジトリが検出網の導出で繰り返し採っている形)。
import { describe, expect, it } from 'vitest';
// ファイル読み込み (Node 標準)
import { readFileSync } from 'node:fs';
// パス結合 (Node 標準)
import { join } from 'node:path';
// semver の範囲判定
import semver from 'semver';
// dependabot.yml の読み方 (eslint 側のガードと共有する。§6 DRY)
import { majorOnlyIgnore } from './lib/dependabot-config';

// リポジトリのルート
const ROOT = process.cwd();

// ロックファイルの中身 (読むのに要る項目だけ)
interface Lockfile {
  packages: Record<
    string,
    {
      version?: string;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    }
  >;
}

// ロックファイルはモジュールの評価時に **1 度だけ**読む (解決済み版と peer の両方をここから導く)。
// 実行中に中身は変わらないので、`it` ごとに読み直すと 300 KB 超の JSON.parse を毎回繰り返すだけになる
// (以前はコメントだけが「1 度だけ」と言っていて、実際は 1 スイートで 2 回読んでいた)
const LOCKFILE = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as Lockfile;

/**
 * 「保留が外れたら入ってくる版」= いま解決している TypeScript の**次の major**。
 *
 * **直書きしない。** `ignore` は `version-update:semver-major` なので **すべての major** を
 * 止める一方、判定の候補を `7.0.0` に固定すると**保留の範囲より判定が狭くなる**。
 * 実測（この差分を書いた時点のロックファイル）:
 *
 * | 候補 | 許さない必須 peer |
 * |---|---|
 * | `7.0.0` | 9 件 |
 * | `6.0.0` | **1 件だけ**（`openapi-typescript` の `^5.x`） |
 *
 * `@typescript-eslint/*` の `>=4.8.4 <6.1.0` は 6.0.0 を**許している**ので、
 * `openapi-typescript` が 6.x を許す版へ上がった時点で 6.x の保留理由は消える。
 * それでも 7.0.0 を見ている判定は 9 件のまま緑で、6.x の更新が永久に抑止される
 * ——このファイルの冒頭が警告している「解除条件が永久に発火しない」形が、
 * 候補を直書きしたことで別の姿で再発する。peer の一覧を導出しているのと
 * 同じ「書かずに導く」原則をここにも当てる。
 */
function nextTypeScriptMajor(lock: Lockfile = LOCKFILE): string {
  // 解決済みの版 (これが読めないと候補を決められないので fail-closed)
  const resolved = lock.packages['node_modules/typescript']?.version;
  if (resolved === undefined) throw new Error('package-lock.json から typescript の版を読めない');
  // 次の major の代表値 (5.9.3 なら 6.0.0)
  const candidate = semver.inc(resolved, 'major');
  if (candidate === null) throw new Error(`typescript の版を semver として読めない: ${resolved}`);
  return candidate;
}

/**
 * ロックファイルから「TypeScript の版を**必須** peer で縛っている依存」を導く。
 *
 * **optional な peer は数えない** — `@prisma/client` のように「あれば使う」宣言は
 * インストールを止めないので、保留の理由にならない。
 */
function requiredTypeScriptPeers(
  lock: Lockfile = LOCKFILE,
): { name: string; range: string; label: string }[] {
  // 必須 peer を宣言しているものだけを集める
  return Object.entries(lock.packages)
    .flatMap(([path, entry]) => {
      // typescript の peer 宣言
      const range = entry.peerDependencies?.typescript;
      // 宣言が無ければ対象外
      if (range === undefined) return [];
      // optional なら保留の理由にならないので外す
      if (entry.peerDependenciesMeta?.typescript?.optional === true) return [];
      // パッケージ名は**最後の `node_modules/` 以降**（先頭だけを外すと、巻き上げが衝突した
      // 入れ子 `node_modules/a/node_modules/b` が `a/node_modules/b` になって読みにくい）。
      // ただし**入れ子のときは出所も残す** — 名前だけに畳むと、巻き上げ済みの写しと
      // 入れ子の写しが同じ綴りになり、「どちらを直せば解除できるか」が分からなくなる
      // (別々の親を持つ 2 つの写しは、重複エントリのようにも見える)
      const name = path.split('node_modules/').pop() ?? path;
      return [
        {
          name,
          range,
          label: name === path.replace(/^node_modules\//, '') ? name : `${name} (${path})`,
        },
      ];
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

describe('TypeScript の major 更新の保留 (dependabot.yml)', () => {
  it('typescript の major だけを止めるエントリがちょうど 1 つある (消失・重複・効きすぎを弾く)', () => {
    // 消失・重複は majorOnlyIgnore が例外で落とす (共有ヘルパー側に集約)
    const entry = majorOnlyIgnore('typescript');
    // update-types が major だけであること (無いと「全バージョン無視」= minor / patch の更新まで止まる)
    expect(entry['update-types']).toEqual(['version-update:semver-major']);
    // versions を足すと同じく効きすぎになる
    expect(entry.versions).toBeUndefined();
  });

  it('必須 peer の導出が 1 件も拾えない状態では落とす (「違反ゼロ = 緑」で無力化されないように)', () => {
    // 導出できた依存
    const peers = requiredTypeScriptPeers();
    // 0 件なら読み方が壊れている (fail-closed)
    expect(peers.length, 'typescript の必須 peer を 1 件も読めない').toBeGreaterThan(0);
  });

  /**
   * 保留の期限切れ。**「次の major が通るようになったか」で落ちる**が、
   * 落ちたときの案内は「ignore を消せ」ではない。
   *
   * `ignore` は `version-update:semver-major` なので **すべての major** を止めており、
   * 次の major（今なら 6.x）の理由が消えても**その上（7.x）はまだ塞がっていることがある**。
   * 実測: `openapi-typescript` の peer を 6.x 許容にすると 6.0.0 の阻害は 0 件になるが、
   * その時点でも 7.0.0 を許さない必須 peer は 9 件残っていた。ここで案内どおり ignore を
   * 削除すると Dependabot は **npm の最新 major**（= 7.x）を提案し、このファイル冒頭が
   * 記録している「3 ジョブすべてが `npm ci` の ERESOLVE で落ちる」状態がそのまま戻る
   * ——しかも警告してくれるはずのガードごと消したあとで。
   *
   * そこで**次の major と、その 1 つ上**の両方の状況を文言に出し、
   * 「消す」か「`versions` で範囲を絞る」かを人が選べるようにする。
   */
  it('保留の期限切れ: 次の major を縛る依存が無くなったら落ちる (落ちたら上の major も確かめてから判断する)', () => {
    // 保留が外れたら入ってくる版 (解決済み版の次の major)
    const candidate = nextTypeScriptMajor();
    // その 1 つ上の major (ignore を消すと Dependabot が提案しうる範囲)
    const beyond = `${semver.major(candidate) + 1}.0.0`;
    // 版ごとに「まだ許していない依存」を数える
    const blockersOf = (version: string): string[] =>
      requiredTypeScriptPeers()
        .filter(({ range }) => !semver.satisfies(version, range))
        .map(({ label, range }) => `${label} (${range})`);
    // 次の major を阻んでいる依存
    const blocking = blockersOf(candidate);
    // その上を阻んでいる依存 (文言に添えて、消してよいかの判断材料にする)
    const beyondBlocking = blockersOf(beyond);
    // 1 つでも残っていれば保留は妥当
    expect(
      blocking.length,
      [
        `TypeScript ${candidate} を許さない依存が無くなった。`,
        `ただし ignore は **すべての major** を止めているので、消す前に上の major も確かめること。`,
        `${beyond} を許さない依存: ${beyondBlocking.length === 0 ? 'なし' : beyondBlocking.join(', ')}`,
        beyondBlocking.length === 0
          ? '→ どの major も塞がっていないので ignore とこのテストを削除してよい。'
          : `→ ${beyond} はまだ塞がっている。ignore は残し、versions で ${candidate} だけを通す形へ絞ること。`,
      ].join('\n'),
    ).toBeGreaterThan(0);
  });
});
