// Vitest のテスト API
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
// eslint の major を止めている理由となる上流プラグイン (eslint-config-next が引き込むもの)
const UPSTREAM_PLUGINS = ['eslint-plugin-react', 'eslint-plugin-import', 'eslint-plugin-jsx-a11y'];
// 保留している eslint の次の major
const NEXT_ESLINT_MAJOR = 10;

// dependabot.yml の npm ブロックの ignore エントリ一覧を返す
type IgnoreEntry = { 'dependency-name': string; 'update-types'?: string[]; versions?: string[] };
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

describe('eslint の major 更新の保留 (dependabot.yml)', () => {
  it('eslint の major だけを止めるエントリがちょうど 1 つある (消失・重複・効きすぎを弾く)', () => {
    // eslint を対象にするエントリ
    const entries = npmIgnores().filter((e) => e['dependency-name'] === 'eslint');
    // 1 つだけ
    expect(entries).toHaveLength(1);
    // update-types が major だけで、versions は無い (どちらも「全バージョン無視」になる形を防ぐ)
    expect(entries[0]['update-types']).toEqual(['version-update:semver-major']);
    expect(entries[0].versions).toBeUndefined();
  });

  it('保留の期限切れ: 上流プラグインが揃って eslint 10 を許したら落ちる (落ちたら ignore とこのテストを消して major を取り込む)', () => {
    // 解決済みの peerDependencies を lockfile から読む
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
    // 各プラグインが eslint 10 を許すか
    const allowsNext = UPSTREAM_PLUGINS.map((name) => {
      // lockfile 上のエントリ
      const entry = lock.packages[`node_modules/${name}`];
      // 読めなければ前提が崩れるので落とす
      expect(entry?.peerDependencies?.eslint, `${name} の peer が読めない`).toBeTypeOf('string');
      // 次の major の代表値が範囲に入るか
      return semver.satisfies(`${NEXT_ESLINT_MAJOR}.0.0`, entry.peerDependencies.eslint);
    });
    // 全員が許した時点で保留の理由が消えるので落とす
    expect(allowsNext.every(Boolean)).toBe(false);
  });
});
