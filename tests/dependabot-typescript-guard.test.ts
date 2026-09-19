// TypeScript の major 更新 (5 → 7) を保留していることと、その保留の期限切れを見張る。
//
// **なぜ止めるか**: lint の経路に載る `typescript-eslint` / `@typescript-eslint/*` は peer で
// `typescript >=4.8.4 <6.1.0` を宣言しており、型生成に使う `openapi-typescript` は `^5.x`。
// TypeScript 7 を入れると `npm ci` が ERESOLVE で落ちるため、CI はインストールの時点で赤になる
// (実測: Dependabot の PR #2 は 3 ジョブすべてが `npm ci` の ERESOLVE で失敗した)。
// **解除条件は「必須 peer を宣言している依存が揃って 7 を許すこと」**で、それはこのテストが
// ロックファイルから導いて判定する。落ちたら ignore とこのテストごと削除して major を取り込む。
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
// YAML パーサ (dependabot.yml)
import { parse } from 'yaml';

// リポジトリのルート
const ROOT = process.cwd();
// 保留している TypeScript の次の major (5 の次に出た major。6 は欠番)
const NEXT_TYPESCRIPT_MAJOR = 7;

// dependabot.yml の ignore エントリ 1 件分
type IgnoreEntry = { 'dependency-name': string; 'update-types'?: string[]; versions?: string[] };

// dependabot.yml の npm ブロック (ルートディレクトリ) の ignore 一覧を返す
function npmIgnores(): IgnoreEntry[] {
  // 設定を読む
  const config = parse(readFileSync(join(ROOT, '.github', 'dependabot.yml'), 'utf8'));
  // npm エコシステムでルートディレクトリのブロックを探す
  const npm = (
    config.updates as { 'package-ecosystem': string; directory: string; ignore?: IgnoreEntry[] }[]
  ).filter((u) => u['package-ecosystem'] === 'npm' && u.directory === '/');
  // ちょうど 1 つあること (別ディレクトリへの置き間違いを弾く)
  expect(npm).toHaveLength(1);
  // ignore 一覧を返す (無ければ空)
  return npm[0].ignore ?? [];
}

/**
 * ロックファイルから「TypeScript の版を**必須** peer で縛っている依存」を導く。
 *
 * **optional な peer は数えない** — `@prisma/client` のように「あれば使う」宣言は
 * インストールを止めないので、保留の理由にならない。
 */
function requiredTypeScriptPeers(): { name: string; range: string }[] {
  // ロックファイルを読む
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
    packages: Record<
      string,
      {
        peerDependencies?: Record<string, string>;
        peerDependenciesMeta?: Record<string, { optional?: boolean }>;
      }
    >;
  };
  // 必須 peer を宣言しているものだけを集める
  return Object.entries(lock.packages)
    .flatMap(([path, entry]) => {
      // typescript の peer 宣言
      const range = entry.peerDependencies?.typescript;
      // 宣言が無ければ対象外
      if (range === undefined) return [];
      // optional なら保留の理由にならないので外す
      if (entry.peerDependenciesMeta?.typescript?.optional === true) return [];
      // node_modules/ を外した名前と範囲を返す
      return [{ name: path.replace(/^node_modules\//, ''), range }];
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

describe('TypeScript の major 更新の保留 (dependabot.yml)', () => {
  it('typescript の major だけを止めるエントリがちょうど 1 つある (消失・重複・効きすぎを弾く)', () => {
    // typescript を対象にするエントリ
    const entries = npmIgnores().filter((e) => e['dependency-name'] === 'typescript');
    // 1 つだけ (Dependabot は同じ依存の複数エントリを**すべて**適用するので、重複は効きすぎになる)
    expect(entries).toHaveLength(1);
    // update-types が major だけであること (無いと「全バージョン無視」= minor / patch の更新まで止まる)
    expect(entries[0]['update-types']).toEqual(['version-update:semver-major']);
    // versions を足すと同じく効きすぎになる
    expect(entries[0].versions).toBeUndefined();
  });

  it('必須 peer の導出が 1 件も拾えない状態では落とす (「違反ゼロ = 緑」で無力化されないように)', () => {
    // 導出できた依存
    const peers = requiredTypeScriptPeers();
    // 0 件なら読み方が壊れている (fail-closed)
    expect(peers.length, 'typescript の必須 peer を 1 件も読めない').toBeGreaterThan(0);
  });

  it('保留の期限切れ: TypeScript の版を縛る依存が揃って 7 を許したら落ちる (落ちたら ignore とこのテストを消して major を取り込む)', () => {
    // 次の major の代表値
    const candidate = `${NEXT_TYPESCRIPT_MAJOR}.0.0`;
    // まだ許していない依存 (この一覧が空になった時点で保留の理由が消える)
    const blocking = requiredTypeScriptPeers().filter(
      ({ range }) => !semver.satisfies(candidate, range),
    );
    // 1 つでも残っていれば保留は妥当 (失敗文言に残っている依存を出し、解除の判断材料にする)
    expect(
      blocking.length,
      `TypeScript ${candidate} を許さない依存が無くなった。ignore とこのテストを削除して major を取り込むこと。`,
    ).toBeGreaterThan(0);
  });
});
