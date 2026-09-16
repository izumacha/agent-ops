// Vitest のテスト API
import { describe, expect, it } from 'vitest';
// ファイル読み込み (Node 標準)
import { readFileSync } from 'node:fs';
// パス結合 (Node 標準)
import { join } from 'node:path';
// semver の範囲判定
import semver from 'semver';

// リポジトリのルート
const ROOT = process.cwd();
// ファイルを文字列で読む小さなヘルパー
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

// 「動かす Node の major」の正本 (.nvmrc)
const pinnedMajor = Number.parseInt(read('.nvmrc').trim(), 10);

describe('動かす Node の major は宣言箇所すべてで一致する', () => {
  it('.nvmrc が整数の major を宣言している (読めなければ前提が崩れるので落とす)', () => {
    // 数値として読めること
    expect(Number.isInteger(pinnedMajor)).toBe(true);
  });

  it('Dockerfile の全ステージが同じ major の node イメージを使う', () => {
    // `FROM node:<major>-...` をすべて拾う
    const majors = [...read('Dockerfile').matchAll(/^FROM node:(\d+)/gm)].map((m) => Number(m[1]));
    // 1 つ以上あり、すべて .nvmrc と一致すること
    expect(majors.length).toBeGreaterThan(0);
    expect(new Set(majors)).toEqual(new Set([pinnedMajor]));
  });

  it('package.json の engines.node は .nvmrc と同じ系列 (N.x) を指す', () => {
    // engines.node を読む
    const engines = JSON.parse(read('package.json')).engines.node as string;
    // 系列の十分新しい版が範囲に入り、隣の major は入らないこと (`>=` の上限無しを弾く)
    expect(semver.satisfies(`${pinnedMajor}.99.0`, engines)).toBe(true);
    expect(semver.satisfies(`${pinnedMajor + 1}.0.0`, engines)).toBe(false);
  });

  it('CI は版を書き写さず .nvmrc を配線で読む', () => {
    // setup-node が node-version-file: .nvmrc を使い、node-version の直書きが無いこと
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toMatch(/node-version-file:\s*\.nvmrc/);
    expect(ci).not.toMatch(/^\s*node-version:/m);
  });

  it('@types/node の major は動かす Node の major と一致する (宣言と解決済み版の両方)', () => {
    // 宣言 (package.json)
    const declared = JSON.parse(read('package.json')).devDependencies['@types/node'] as string;
    expect(semver.minVersion(declared)?.major).toBe(pinnedMajor);
    // 解決済み (package-lock.json)
    const lock = JSON.parse(read('package-lock.json'));
    const resolved = lock.packages['node_modules/@types/node'].version as string;
    expect(semver.major(resolved)).toBe(pinnedMajor);
  });
});
