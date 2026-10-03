// レート制限（src/lib/api/rate-limit.ts）の検査。
// **時刻を引数で受け取る形**にしてあるので、窓の境界を決定的に固定できる（実時間を待たない）。
import { describe, expect, it } from 'vitest';
import {
  configuredRateLimit,
  enforceRateLimit,
  extraRateLimiter,
  RATE_LIMIT_TIER,
  rateLimitKeyFor,
  rateLimitedError,
  resetSharedRateLimiterForTesting,
  sharedRateLimiter,
  SlidingWindowRateLimiter,
} from '@/lib/api/rate-limit';
import { ApiError } from '@/lib/api/errors';
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

  it('時計が巻き戻っても Retry-After は窓の長さを超えない', () => {
    // **記録は push 順なので「昇順に並んでいる」は時刻が単調増加することに依存する。**
    // 呼び出し側は Date.now() を渡すので NTP の時刻合わせで巻き戻りうる。先頭の記録を
    // 「最も古い」と決めつけると、巻き戻った幅だけ待ち時間を長く返し、素直に従う
    // クライアントが必要以上に待つ
    const rl = limiter();
    // まず新しい時刻で 1 件、そのあと巻き戻った時刻で上限まで使う
    rl.check('k', T0 + WINDOW_MS / 2);
    for (let i = 1; i < LIMIT; i += 1) rl.check('k', T0);
    // 断られたときの待ち時間は、どの記録が先頭にあっても窓の長さ以内
    const decision = rl.check('k', T0);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeLessThanOrEqual(WINDOW_MS / 1_000);
    expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
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
  it('テナント単位で数え、プラットフォーム管理者だけ単一の枠になる', () => {
    // **偽装できる値（IP・ヘッダ）は使わない**のが要点。3 種類の主体を確かめる。
    // **資格情報ごと（API キー・ユーザー）にしない** — どちらも API から好きなだけ増やせるので、
    // 枠を資格情報ごとに持つとキーを増やすだけで上限が何倍にもなる
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
    ).toBe('tenant:tn-1');
    // ユーザーも同じテナントの枠（admin がユーザーを増やしても枠は増えない）
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
    ).toBe('tenant:tn-1');
    // プラットフォーム管理者トークンは 1 本しかないので単一の枠
    expect(rateLimitKeyFor({ kind: 'platform' })).toBe('platform');
  });

  it('同じ id でも種類が違えば枠を共有しない', () => {
    // 接頭辞があるので、たまたま同じ id でも別の枠になる
    expect(rateLimitKeyFor({ kind: 'platform' })).not.toBe('tenant:platform');
  });
});

describe('ルートに載るレート制限の印', () => {
  // **印そのものの挙動を固定する。** この印は検出網 (tests/route-wrapping.test.ts) が
  // 「そのルートが制限を掛けているか」を綴りに頼らず読むための唯一の手がかりなので、
  // 常に値を返すよう書き換えても**本番の挙動は変わらない**（実測で全件緑のまま通った）。
  // 印が嘘をつく変異はここでしか落ちないので、向きをすべて直接確かめる
  it('指定した枠をそのまま申告し、指定が無ければ null になる', async () => {
    // 包む対象は何でもよい（印は包んだ関数に載る）
    const { route, ROUTE_RATE_LIMIT_BRAND } = await import('@/lib/api/handler');
    // 何も指定しなければ「掛けない」側（既定は fail-open だが、印はそれを正しく申告する）
    const plain = route(async () => new Response(null)) as unknown as Record<symbol, unknown>;
    expect(plain[ROUTE_RATE_LIMIT_BRAND]).toBeNull();
    // **枠の種類まで載る** — 真偽値だと、重い経路の指定を standard へ落とす変更が
    // 検出網から見えない（印は「掛かっている」のままなので）
    for (const tier of Object.values(RATE_LIMIT_TIER)) {
      const limited = route(async () => new Response(null), {
        rateLimit: tier,
      }) as unknown as Record<symbol, unknown>;
      expect(limited[ROUTE_RATE_LIMIT_BRAND]).toBe(tier);
    }
  });
});

describe('覗き見だけの判定 (inspect)', () => {
  it('数えないので、何回呼んでも通し続ける', () => {
    // 上限 3 の制限器
    const limiter = new SlidingWindowRateLimiter({ limit: LIMIT, windowMs: WINDOW_MS });
    // 上限より多く覗き見しても通る（覗き見は記録を増やさない）
    for (let index = 0; index < LIMIT + 5; index += 1) {
      expect(limiter.inspect('k', T0).allowed).toBe(true);
    }
    // 記録は 1 件も無い（キーごと表に無い）
    expect(limiter.trackedKeys).toBe(0);
  });

  it('上限に達していれば check と同じ待ち時間を返す', () => {
    // 上限 1 の制限器
    const limiter = new SlidingWindowRateLimiter({ limit: 1, windowMs: WINDOW_MS });
    // 1 件数える
    expect(limiter.check('k', T0).allowed).toBe(true);
    // 覗き見でも断り、待ち時間は窓の長さぶん（秒へ切り上げ）
    const peeked = limiter.inspect('k', T0);
    expect(peeked.allowed).toBe(false);
    expect(peeked.retryAfterSeconds).toBe(WINDOW_MS / 1000);
  });
});

describe('枠の組み合わせ (enforceRateLimit)', () => {
  // 検査に使う主体（キーは `apiKey:<id>` になる）
  const principal = {
    kind: 'agent',
    apiKeyId: 'key-1',
    tenantId: 't1',
    agent: { id: 'a1', status: 'active', provider: Provider.anthropic, model: 'm' },
  } as unknown as Parameters<typeof enforceRateLimit>[0];

  it('重い経路は小さい枠と共有の枠の両方を消費する', () => {
    // 共有は 10、重いほうは 2 で作り直す
    resetSharedRateLimiterForTesting(
      { limit: 10, windowMs: WINDOW_MS },
      { limit: 2, windowMs: WINDOW_MS },
    );
    // 重い経路を 2 回通す（小さい枠の上限まで）
    enforceRateLimit(principal, RATE_LIMIT_TIER.fanOut, T0);
    enforceRateLimit(principal, RATE_LIMIT_TIER.fanOut, T0);
    // 3 回目は小さい枠で断られる
    expect(() => enforceRateLimit(principal, RATE_LIMIT_TIER.fanOut, T0)).toThrow();
    // **共有の枠も 2 件ぶん消費されている** — 置き換えだと、重い経路と中継を交互に叩くだけで
    // 合計が共有の上限を超える。残りは 10 - 2 = 8 件なので、8 回は通って 9 回目で断られる
    for (let index = 0; index < 8; index += 1) {
      enforceRateLimit(principal, RATE_LIMIT_TIER.standard, T0);
    }
    expect(() => enforceRateLimit(principal, RATE_LIMIT_TIER.standard, T0)).toThrow();
  });

  // **枠の種類を足した人が「実際に数えられるか」を確かめなくてよくならないようにする。**
  // 上のテストは `fanOut` を名指しするので、種類を足して `EXTRA_FRAME_LIMIT` に書くだけでは
  // 1 度も通らない（表に載っただけで枠が効いているかは誰も見ていない状態になる）
  it.each(Object.values(RATE_LIMIT_TIER).filter((tier) => extraRateLimiter(tier) !== undefined))(
    '追加の枠を持つ種類は共有の枠と独立に数える (%s)',
    (tier) => {
      // 共有は 10、追加の枠は 2 で作り直す
      resetSharedRateLimiterForTesting(
        { limit: 10, windowMs: WINDOW_MS },
        { limit: 2, windowMs: WINDOW_MS },
      );
      // 追加の枠の上限まで通す
      enforceRateLimit(principal, tier, T0);
      enforceRateLimit(principal, tier, T0);
      // 次は追加の枠で断られる（共有にはまだ 8 件の余裕がある）
      expect(() => enforceRateLimit(principal, tier, T0)).toThrow();
      // 共有の枠は 2 件ぶん減っている（置き換えではなく「加えて」消費する）
      for (let index = 0; index < 8; index += 1) {
        enforceRateLimit(principal, RATE_LIMIT_TIER.standard, T0);
      }
      expect(() => enforceRateLimit(principal, RATE_LIMIT_TIER.standard, T0)).toThrow();
    },
  );

  it('断った要求はどちらの枠にも数えない', () => {
    // 共有は 1、重いほうは 5（**共有のほうが先に尽きる**組み合わせ）
    resetSharedRateLimiterForTesting(
      { limit: 1, windowMs: WINDOW_MS },
      { limit: 5, windowMs: WINDOW_MS },
    );
    // 共有の枠を使い切る
    enforceRateLimit(principal, RATE_LIMIT_TIER.standard, T0);
    // 重い経路は共有の枠で断られる
    expect(() => enforceRateLimit(principal, RATE_LIMIT_TIER.fanOut, T0)).toThrow();
    // **小さい枠は 1 件も数えていない** — 順に check を呼ぶ形だと、通った側だけが
    // 数えてしまい、断られ続けるあいだ小さい枠が減り続ける
    expect(extraRateLimiter(RATE_LIMIT_TIER.fanOut)?.trackedKeys).toBe(0);
    // 共有の枠は使い切ったぶんだけ（断った要求で増えていない）
    expect(sharedRateLimiter().trackedKeys).toBe(1);
  });

  it('断るときは待ち時間の長いほうを返す', () => {
    // 共有は 1、重いほうも 1 で作り直す
    resetSharedRateLimiterForTesting(
      { limit: 1, windowMs: WINDOW_MS },
      { limit: 1, windowMs: WINDOW_MS },
    );
    // 両方の枠を使い切る（共有は T0、小さい枠も T0）
    enforceRateLimit(principal, RATE_LIMIT_TIER.fanOut, T0);
    // 共有の枠だけをさらに古くするため、少し進めた時刻で中継を 1 回…は通らないので、
    // ここでは「両方が断る」状況で例外の待ち時間が正の整数であることを確かめる
    let thrown: unknown = null;
    try {
      enforceRateLimit(principal, RATE_LIMIT_TIER.fanOut, T0 + 1_000);
    } catch (error) {
      thrown = error;
    }
    // 429 ＋ Retry-After が載る
    expect(thrown).toBeInstanceOf(ApiError);
    const headers = (thrown as ApiError).headers ?? {};
    expect((thrown as ApiError).status).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
    // 残り 59 秒（窓 60 秒 - 経過 1 秒）
    expect(headers['Retry-After']).toBe('59');
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
