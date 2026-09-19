// 「ランタイムを上げる判断」の側で上げる依存の major 保留を見張る (`@types/node` と docker の `node`)。
//
// **eslint / typescript のガードとは別ファイルにする。** あちらは
// 「上流が次の major を許したら ignore とテストごと削除する」運用で、
// **ファイルごと消えることが正しい**。この 2 つの保留は解除条件が上流ではなく人の判断なので
// **消えない**のに、同じファイルへ同居させると eslint 10 が来た日に巻き添えで消える。
// 実測: `tests/dependabot-eslint-guard.test.ts` を運用どおり削除したうえで
// `@types/node` と docker の `node` の ignore を両方外すと **371 件すべて緑**で通り、
// 痕跡はテスト件数が 375 → 371 へ減ることだけだった（正当な後始末と見分けが付かない）。
// これはこのリポジトリが繰り返し塞いでいる「痕跡はテスト件数の減少だけ」の形そのもの。
import { describe, expect, it } from 'vitest';
// dependabot.yml の読み方 (他の保留ガードと共有する。§6 DRY)
import { majorOnlyIgnore } from './lib/dependabot-config';

describe('ランタイム連動の major 保留 (dependabot.yml)', () => {
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
