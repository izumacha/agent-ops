// レート制限（src/lib/api/rate-limit.ts）の検査。
// **時刻を引数で受け取る形**にしてあるので、窓の境界を決定的に固定できる（実時間を待たない）。
import { describe, expect, it } from 'vitest';
import {
  configuredRateLimit,
  rateLimitKeyFor,
  rateLimitedError,
  SlidingWindowRateLimiter,
} from '@/lib/api/rate-limit';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { Provider, Role } from '@/domain/types';
import { PROXY_RATE_LIMIT_ENV, PROXY_RATE_LIMIT_PER_MINUTE } from '@/lib/constants';

// 検査で使う窓の長さ（1 分）
const WINDOW_MS = 60_000;
// 検査で使う上限（境界が読みやすい小さい値）
const LIMIT = 3;
// 起点の時刻（絶対値には意味が無いが、固定して境界を読みやすくする）
const T0 = 1_000_000;

// 既定の設定で制限器を作る
function limiter(limit = LIMIT, windowMs = WINDOW_MS): SlidingWindowRateLimiter {
  // 上限と窓を渡す
  return new SlidingWindowRateLimiter({ limit, windowMs });
}

describe('スライディングウィンドウのレート制限', () => {
  it('上限までは通し、超えた分を断る', () => {
    // 同じ時刻で上限回まで通る
    const rl = limiter();
    for (let i = 0; i < LIMIT; i += 1) {
      expect(rl.check('k', T0).allowed).toBe(true);
    }
    // 上限を 1 つ超えた呼び出しは断られる
    expect(rl.check('k', T0).allowed).toBe(false);
  });

  it('断った呼び出しは数えないので、窓が延びない', () => {
    // **断られ続けると窓が延びる**形にしてはいけない（永久に通れなくなる）。
    // 上限まで使ってから何度も断られ、窓が過ぎたら通ることを確かめる
    const rl = limiter();
    for (let i = 0; i < LIMIT; i += 1) rl.check('k', T0);
    // 窓の途中で 5 回断られる
    for (let i = 0; i < 5; i += 1) {
      expect(rl.check('k', T0 + 1_000).allowed).toBe(false);
    }
    // 最初の記録が窓から外れた時点で通る（断られた 5 回は記録に残っていない）
    expect(rl.check('k', T0 + WINDOW_MS).allowed).toBe(true);
  });

  it('窓は過去側が半開（ちょうど窓の長さだけ前の記録は外れている）', () => {
    // 集計窓（`src/domain/guardrail/rule.ts` の `guardrailWindow`）と同じ約束にそろえる:
    // 時刻 now の窓は `(now - windowMs, now]` を覆うので、ちょうど windowMs 前の記録は
    // すでに「窓の外」。境界をどちらに寄せるかで 1 件ぶん答えが変わるので明示的に固定する
    const rl = limiter();
    for (let i = 0; i < LIMIT; i += 1) rl.check('k', T0);
    // 窓の終わり間際（残り 1 ミリ秒）ではまだ窓の中なので断られる
    expect(rl.check('k', T0 + WINDOW_MS - 1).allowed).toBe(false);
    // 窓の長さぴったりで最初の記録が外れるので通る
    expect(rl.check('k', T0 + WINDOW_MS).allowed).toBe(true);
  });

  it('Retry-After は「最も古い記録が窓から外れるまで」の秒数（整数・最低 1 秒）', () => {
    // 上限まで使う
    const rl = limiter();
    for (let i = 0; i < LIMIT; i += 1) rl.check('k', T0);
    // 直後に断られると、残りはほぼ窓いっぱい
    expect(rl.check('k', T0).retryAfterSeconds).toBe(WINDOW_MS / 1_000);
    // 窓の終わり間際（残り 1 ミリ秒）でも **0 秒ではなく 1 秒**を返す。
    // RFC 9110 の delay-seconds は整数で、0 は「すぐ試してよい」に見えるので切り上げる
    expect(rl.check('k', T0 + WINDOW_MS - 1).retryAfterSeconds).toBe(1);
  });

  it('キーごとに枠が独立している', () => {
    // 1 つのキーで使い切っても別のキーは通る
    const rl = limiter();
    for (let i = 0; i < LIMIT; i += 1) rl.check('a', T0);
    expect(rl.check('a', T0).allowed).toBe(false);
    expect(rl.check('b', T0).allowed).toBe(true);
  });

  it('期限切れの記録は間隔ごとに回収され、キーごと消える', () => {
    // **「表が満杯のとき」でも「1 窓に 1 回」でもなく間隔で走らせる**ことの検査。
    // 1 つのキーを使って窓を過ぎてから別のキーで叩くと、古いキーが表から消える
    const rl = limiter();
    rl.check('old', T0);
    expect(rl.trackedKeys).toBe(1);
    // 窓を越えた時刻で別のキーを叩く（このとき掃除の間隔も越えている）
    rl.check('new', T0 + WINDOW_MS + 1);
    // 古いキーは回収され、新しいキーだけが残る
    expect(rl.trackedKeys).toBe(1);
    expect(rl.check('old', T0 + WINDOW_MS + 1).allowed).toBe(true);
  });

  it('掃除は呼び出し回数に比例しない（間隔で絞る）', () => {
    // **絞らないと、使い捨てキーで表を膨らませたうえで全リクエストに走査の費用を負わせられる**。
    // 同じ時刻で 1000 回叩いても掃除は 1 度も走らない
    const rl = limiter(10_000);
    for (let i = 0; i < 1_000; i += 1) rl.check(`k${i}`, T0);
    expect(rl.sweepCount).toBe(0);
    // 間隔（窓の 1/60 = 1 秒）を越えると 1 度走る
    rl.check('k', T0 + 1_001);
    expect(rl.sweepCount).toBe(1);
    // すぐもう 1 回叩いても増えない
    rl.check('k', T0 + 1_002);
    expect(rl.sweepCount).toBe(1);
  });

  it('上限や窓が正の整数でなければ作れない（fail-closed）', () => {
    // **窓が 0 だと記録が常に空になりレート制限が丸ごと無効になる**ので作らせない
    for (const options of [
      { limit: 0, windowMs: WINDOW_MS },
      { limit: -1, windowMs: WINDOW_MS },
      { limit: 1.5, windowMs: WINDOW_MS },
      { limit: LIMIT, windowMs: 0 },
      { limit: LIMIT, windowMs: -1 },
      { limit: LIMIT, windowMs: 1.5 },
      { limit: Number.NaN, windowMs: WINDOW_MS },
    ]) {
      expect(() => new SlidingWindowRateLimiter(options)).toThrow(RangeError);
    }
  });
});

describe('レート制限のキー', () => {
  it('認証済みの id から作り、種類ごとに接頭辞を付ける', () => {
    // **偽装できる値（IP・ヘッダ）は使わない**のが要点。3 種類の主体を確かめる
    expect(
      rateLimitKeyFor({
        kind: 'agent',
        tenantId: 'tn-1',
        apiKeyId: 'ak-1',
        agent: {
          id: 'ag-1',
          tenantId: 'tn-1',
          name: 'bot',
          description: null,
          provider: Provider.anthropic,
          model: 'claude-sonnet-4-6',
          budgetMicroUsd: null,
          status: 'active',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }),
    ).toBe('apiKey:ak-1');
    // ユーザーはユーザー単位
    expect(
      rateLimitKeyFor({
        kind: 'user',
        tenantId: 'tn-1',
        user: {
          id: 'us-1',
          tenantId: 'tn-1',
          email: 'a@example.com',
          name: 'A',
          role: Role.admin,
          disabledAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }),
    ).toBe('user:us-1');
    // プラットフォーム管理者トークンは 1 本しかないので単一の枠
    expect(rateLimitKeyFor({ kind: 'platform' })).toBe('platform');
  });

  it('同じ id でも種類が違えば枠を共有しない', () => {
    // 接頭辞があるので、たまたま同じ id でも別の枠になる
    expect(rateLimitKeyFor({ kind: 'platform' })).not.toBe('apiKey:platform');
  });
});

describe('レート制限の例外', () => {
  it('429 と Retry-After を持つ', () => {
    // 秒数はヘッダに整数の文字列で載る
    const error = rateLimitedError(42);
    expect(error.status).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
    expect(error.headers).toEqual({ 'Retry-After': '42' });
  });
});

describe('上限の環境変数による上書き', () => {
  // 環境変数を組み立てる（NODE_ENV は ProcessEnv で必須）
  function env(value: string | undefined): NodeJS.ProcessEnv {
    // 指定された値だけを入れる
    return { NODE_ENV: 'test', [PROXY_RATE_LIMIT_ENV]: value } as NodeJS.ProcessEnv;
  }

  it('未設定なら既定の上限', () => {
    // 未設定・空文字・空白だけはすべて既定
    for (const value of [undefined, '', '   ']) {
      expect(configuredRateLimit(env(value))).toBe(PROXY_RATE_LIMIT_PER_MINUTE);
    }
  });

  it('正の整数なら上書きが効く（ベンチが計測を妨げられないようにする用途）', () => {
    // 前後の空白は落とす
    expect(configuredRateLimit(env('1234'))).toBe(1234);
    expect(configuredRateLimit(env(' 1234 '))).toBe(1234);
  });

  it.each([
    ['0（制限が丸ごと無効になる）', '0'],
    ['負の値', '-1'],
    ['小数', '1.5'],
    ['数値でない', 'たくさん'],
    ['指数表記でない混在', '12abc'],
    ['Infinity', 'Infinity'],
    ['NaN', 'NaN'],
  ])('読めない値は既定へ倒す（fail-closed）: %s', (_label, value) => {
    // **設定ミスで制限が消えるより、効いている方が安全**
    expect(configuredRateLimit(env(value))).toBe(PROXY_RATE_LIMIT_PER_MINUTE);
  });
});
