// Composition Root (src/data/index.ts) の fail-closed ガード。
// setReposForTesting は本番で呼べてはいけない — 呼べるとデータ層を丸ごと別実装へ差し替えられる
import { afterEach, describe, expect, it } from 'vitest';
import { setReposForTesting } from '@/data';

// NODE_ENV は型定義上 読み取り専用なので、書き換えは env 全体を可変として扱う小さなヘルパーに閉じる
const env = process.env as Record<string, string | undefined>;
// 元の NODE_ENV (テストごとに戻す)
const original = env.NODE_ENV;
afterEach(() => {
  // 書き換えた値を戻す (他のテストへ影響させない)
  env.NODE_ENV = original;
});

describe('setReposForTesting', () => {
  it('NODE_ENV=production では throw する (本番で差し替えさせない)', () => {
    // 本番のふりをする
    env.NODE_ENV = 'production';
    // 差し替えは拒否される
    expect(() => setReposForTesting(undefined)).toThrow(/本番では使えません/);
  });

  it('本番でなければ差し替えられる (テストが依存している経路)', () => {
    // テスト環境のまま
    env.NODE_ENV = 'test';
    // undefined で本番の束へ戻す操作は通る
    expect(() => setReposForTesting(undefined)).not.toThrow();
  });
});
