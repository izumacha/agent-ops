// トークンの生成・ハッシュ・定数時間比較 (src/lib/tokens.ts)
import { describe, expect, it } from 'vitest';
import {
  API_KEY_PREFIX,
  displayPrefix,
  generateSecret,
  hashSecret,
  isUserToken,
  secretsEqual,
  USER_TOKEN_PREFIX,
} from '@/lib/tokens';

describe('tokens', () => {
  it('種類ごとの接頭辞が付き、毎回異なる値になる', () => {
    // ユーザートークン
    const user = generateSecret('user');
    expect(user.startsWith(USER_TOKEN_PREFIX)).toBe(true);
    expect(isUserToken(user)).toBe(true);
    // API キー
    const key = generateSecret('apiKey');
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(isUserToken(key)).toBe(false);
    // 乱数なので一致しない
    expect(generateSecret('user')).not.toBe(user);
  });

  it('ハッシュは決定的で、平文を含まない 64 桁の 16 進', () => {
    // 同じ入力は同じハッシュ
    const secret = generateSecret('user');
    expect(hashSecret(secret)).toBe(hashSecret(secret));
    expect(hashSecret(secret)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSecret(secret)).not.toContain(secret.slice(USER_TOKEN_PREFIX.length));
  });

  it('表示用の先頭は接頭辞 + 数文字で、全体より短い', () => {
    // 先頭部分
    const secret = generateSecret('apiKey');
    const prefix = displayPrefix(secret);
    expect(secret.startsWith(prefix)).toBe(true);
    expect(prefix.length).toBeLessThan(secret.length / 2);
  });

  it('secretsEqual は一致だけを true にし、長さ違いでも例外を出さない', () => {
    // 一致
    expect(secretsEqual('abc', 'abc')).toBe(true);
    // 不一致 (長さ違い含む)
    expect(secretsEqual('abc', 'abd')).toBe(false);
    expect(secretsEqual('abc', 'abcd')).toBe(false);
    expect(secretsEqual('', 'a')).toBe(false);
  });
});
