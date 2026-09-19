// Vitest のテスト API
import { describe, expect, it } from 'vitest';
// ファイル読み込み (Node 標準)
import { readFileSync } from 'node:fs';
// パス結合 (Node 標準)
import { join } from 'node:path';
// semver の範囲判定
import semver from 'semver';
// dependabot.yml の読み方 (typescript 側のガードと共有する。§6 DRY)
import { majorOnlyIgnore } from './lib/dependabot-config';

// リポジトリのルート
const ROOT = process.cwd();
// eslint の major を止めている理由となる上流プラグイン (eslint-config-next が引き込むもの)
const UPSTREAM_PLUGINS = ['eslint-plugin-react', 'eslint-plugin-import', 'eslint-plugin-jsx-a11y'];
// 保留している eslint の次の major
const NEXT_ESLINT_MAJOR = 10;

describe('その他の major 保留 (dependabot.yml)', () => {
  // **ガードの無い保留を残さない。** `@types/node` と docker の `node` は
  // 「ランタイムを上げる判断の側で一緒に上げる」ために止めているが、
  // `tests/node-runtime-alignment.test.ts` が見るのは宣言と解決済み版の一致だけで、
  // **dependabot のエントリそのものは誰も見ていなかった**。消えても全件緑のまま通り、
  // 気付けるのは「型だけが先に進んだ PR が毎週立つ」ときになる（そのとき typecheck は
  // 緑のままなので、壊れるのは出荷先の実行時）。
  // 期限切れの判定は持たない — 解除条件は上流ではなく「ランタイムを上げる判断」で、
  // 機械的に導けるものではない（CLAUDE.md §2）。
  it.each([
    { label: '@types/node (npm)', name: '@types/node', ecosystem: 'npm' },
    { label: 'node ベースイメージ (docker)', name: 'node', ecosystem: 'docker' },
  ])('$label の major だけを止めるエントリがちょうど 1 つある', ({ name, ecosystem }) => {
    // 消失・重複は majorOnlyIgnore が例外で落とす
    const entry = majorOnlyIgnore(name, ecosystem);
    // update-types が major だけで、versions は無い (どちらも「全バージョン無視」になる形を防ぐ)
    expect(entry['update-types']).toEqual(['version-update:semver-major']);
    expect(entry.versions).toBeUndefined();
  });
});

describe('eslint の major 更新の保留 (dependabot.yml)', () => {
  it('eslint の major だけを止めるエントリがちょうど 1 つある (消失・重複・効きすぎを弾く)', () => {
    // 消失・重複は majorOnlyIgnore が例外で落とす (共有ヘルパー側に集約)
    const entry = majorOnlyIgnore('eslint');
    // update-types が major だけで、versions は無い (どちらも「全バージョン無視」になる形を防ぐ)
    expect(entry['update-types']).toEqual(['version-update:semver-major']);
    expect(entry.versions).toBeUndefined();
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
