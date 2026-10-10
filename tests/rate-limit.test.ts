// レート制限の**方針**（`src/lib/api/rate-limit.ts`）の検査。
//
// **窓の数え方そのものは data 層へ移った**（ADR-0015）ので、境界・半開区間・掃き出しは
// `tests/data/memory-rate-limit.test.ts`（memory）と `tests/data/rate-limit.contract.prisma.test.ts`
// （実 DB）が固定する。ここで見るのは「どのキーで数えるか」「どの上限を使うか」
// 「断ったときに何秒待たせるか」「ストアが落ちたらどう倒れるか」。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enforceRateLimit,
  extraRateLimitFor,
  RATE_LIMIT_TIER,
  rateLimitKeyFor,
  rateLimitedError,
  rateLimitOverrideFromEnv,
  retryAfterSecondsFor,
  setRateLimitOverridesForTesting,
  sharedRateLimitFor,
} from '@/lib/api/rate-limit';
import type { Principal } from '@/lib/api/auth';
import type { RateLimitTier } from '@/lib/api/rate-limit';
import { ApiError } from '@/lib/api/errors';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { Plan, Provider, Role } from '@/domain/types';
import { PROXY_RATE_LIMIT_ENV } from '@/lib/constants';
import { FALLBACK_PLAN, PLAN_LIMITS } from '@/domain/plan';
import { createMemoryRepos, MemoryStore } from '@/data/adapters/memory';
import type { RateLimitConsumeResult, Repositories } from '@/data/ports';
import { captureLogOutlet, loggedEvents } from './lib/log-lines';
import { resetThrottledLogsForTesting } from '@/lib/log';

// 検査で使う窓の長さ（1 分）
const WINDOW_MS = 60_000;
// 起点の時刻（絶対値には意味が無いが、固定して境界を読みやすくする）
const T0 = new Date('2026-10-09T00:00:00.000Z');

// **各テストの前に上限の上書きを本番と同じ決め方へ戻す。** 上書きはモジュール変数なので、
// 上書きしたテストの後ろに「本番の決め方」を見るテストが来ると実行順に依存して落ちる
beforeEach(() => {
  setRateLimitOverridesForTesting();
  // 間引きの記憶も忘れる（ストア障害の記録は窓の中の通算件数が 2 の冪の回だけ行になる）
  resetThrottledLogsForTesting();
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
        plan: Plan.pro,
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
        plan: Plan.pro,
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

describe('枠の組み合わせ (enforceRateLimit)', () => {
  // 検査に使う主体（キーは `tenant:t1` になる）
  const principal = {
    kind: 'agent',
    apiKeyId: 'key-1',
    tenantId: 't1',
    plan: Plan.pro,
    agent: { id: 'a1', status: 'active', provider: Provider.anthropic, model: 'm' },
  } as unknown as Principal;

  // 記録は毎テストで新しい memory の表にする（前のテストの枠が漏れない）
  let repos: Repositories & { store: MemoryStore };

  beforeEach(() => {
    repos = createMemoryRepos(new MemoryStore());
  });

  it('重い経路は追加の枠と共有の枠の両方を消費する', async () => {
    // 共有は 10、追加は 2
    setRateLimitOverridesForTesting({ limit: 10, windowMs: WINDOW_MS }, { limit: 2 });
    // 重い経路を 2 回通す（追加の枠の上限まで）
    await enforceRateLimit(repos, principal, RATE_LIMIT_TIER.fanOut);
    await enforceRateLimit(repos, principal, RATE_LIMIT_TIER.fanOut);
    // 3 回目は追加の枠で断られる
    await expect(enforceRateLimit(repos, principal, RATE_LIMIT_TIER.fanOut)).rejects.toBeInstanceOf(
      ApiError,
    );
    // **共有の枠も 2 件ぶん消費されている** — 置き換えだと、重い経路と中継を交互に叩くだけで
    // 合計が共有の上限を超える。残りは 10 - 2 = 8 件なので、8 回は通って 9 回目で断られる
    for (let index = 0; index < 8; index += 1) {
      await enforceRateLimit(repos, principal, RATE_LIMIT_TIER.standard);
    }
    await expect(
      enforceRateLimit(repos, principal, RATE_LIMIT_TIER.standard),
    ).rejects.toBeInstanceOf(ApiError);
  });

  // **枠の種類を足した人が「実際に数えられるか」を確かめなくてよくならないようにする。**
  // 上のテストは `fanOut` を名指しするので、種類を足して `EXTRA_FRAME_LIMIT` に書くだけでは
  // 1 度も通らない（表に載っただけで枠が効いているかは誰も見ていない状態になる）。
  // **一覧は表から導く**（追加の枠を持つ種類を手で並べない）
  it.each(Object.values(RATE_LIMIT_TIER).filter((tier) => extraRateLimitFor(tier) !== null))(
    '追加の枠を持つ種類は共有の枠と独立に数える (%s)',
    async (tier) => {
      // 共有は 10、追加は 2
      setRateLimitOverridesForTesting({ limit: 10, windowMs: WINDOW_MS }, { limit: 2 });
      // 追加の枠の上限まで通す
      await enforceRateLimit(repos, principal, tier);
      await enforceRateLimit(repos, principal, tier);
      // 次は追加の枠で断られる（共有にはまだ 8 件の余裕がある）
      await expect(enforceRateLimit(repos, principal, tier)).rejects.toBeInstanceOf(ApiError);
      // 共有の枠は 2 件ぶん減っている（置き換えではなく「加えて」消費する）
      for (let index = 0; index < 8; index += 1) {
        await enforceRateLimit(repos, principal, RATE_LIMIT_TIER.standard);
      }
      await expect(
        enforceRateLimit(repos, principal, RATE_LIMIT_TIER.standard),
      ).rejects.toBeInstanceOf(ApiError);
    },
  );

  it('断った要求はどちらの枠にも数えない', async () => {
    // 共有は 1、追加は 5（**共有のほうが先に尽きる**組み合わせ）
    setRateLimitOverridesForTesting({ limit: 1, windowMs: WINDOW_MS }, { limit: 5 });
    // 共有の枠を使い切る
    await enforceRateLimit(repos, principal, RATE_LIMIT_TIER.standard);
    // 重い経路は共有の枠で断られる
    await expect(enforceRateLimit(repos, principal, RATE_LIMIT_TIER.fanOut)).rejects.toBeInstanceOf(
      ApiError,
    );
    // **記録は使い切った 1 件だけ** — 判定と記録が同じ操作なので、片方だけ消費された
    // 状態にならない（以前は 2 つの表を順に数えていたので、通った側だけが減りえた）
    expect(repos.store.rateLimitHits.get('tenant:t1')).toHaveLength(1);
  });

  it('断るときは待ち時間を Retry-After に載せる（窓の残りぶん）', async () => {
    // 共有も追加も 1 で、両方を使い切る
    setRateLimitOverridesForTesting({ limit: 1, windowMs: WINDOW_MS }, { limit: 1 });
    // **記録側の時計を固定して進める**（待ち時間は記録側の時刻で決まる。理由は結果の `at`）
    let clock = T0;
    repos.store.now = () => clock;
    await enforceRateLimit(repos, principal, RATE_LIMIT_TIER.fanOut);
    // 1 秒進めてから同じ経路を叩くと断られる
    clock = new Date(T0.getTime() + 1_000);
    const thrown = await enforceRateLimit(repos, principal, RATE_LIMIT_TIER.fanOut).catch(
      (error: unknown) => error,
    );
    // 429 ＋ Retry-After が載る
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
    // 残り 59 秒（窓 60 秒 - 経過 1 秒）
    expect(((thrown as ApiError).headers ?? {})['Retry-After']).toBe('59');
  });

  it('枠を数えられなかった（混雑）ときは 429 で断り、専用の出来事を残す', async () => {
    // 記録側が「順番待ちを打ち切った」と返す状況を作る
    vi.spyOn(repos.rateLimit, 'consume').mockResolvedValue({
      allowed: false,
      at: T0,
      contended: true,
      sharedCount: 0,
      extraCount: 0,
      sharedOldest: null,
      extraOldest: null,
    });
    const outlet = captureLogOutlet();
    try {
      // 429 で断る（**500 ではない** — 断れているので上限超過と同じ扱い）
      const thrown = await enforceRateLimit(repos, principal, RATE_LIMIT_TIER.standard).catch(
        (error: unknown) => error,
      );
      expect(thrown).toBeInstanceOf(ApiError);
      expect((thrown as ApiError).status).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
      // **数えられていないので最短の待ち時間**（最古が無いので下限の 1 秒）
      expect(((thrown as ApiError).headers ?? {})['Retry-After']).toBe('1');
      // **上限超過と区別できる記録が残る** — 混ざると運用者は「上限を上げれば直る」と読む
      expect(loggedEvents(outlet.calls())).toEqual(['rate_limit.contended']);
    } finally {
      outlet.restore();
      vi.restoreAllMocks();
    }
  });

  it('ストアが落ちたら通さず、専用の出来事を残す（fail-closed）', async () => {
    // 記録側を落とす（DB 障害を模す）
    const failure = new Error('接続できません');
    vi.spyOn(repos.rateLimit, 'consume').mockRejectedValue(failure);
    // 出口を捕まえる
    const outlet = captureLogOutlet();
    try {
      // **通さない**（例外はそのまま上がって 500 になる。429 ではない）
      await expect(enforceRateLimit(repos, principal, RATE_LIMIT_TIER.standard)).rejects.toBe(
        failure,
      );
      // **汎用の 500 に埋もれさせない** — 運用者が知りたいのは「上限超過か、数えられていないか」
      expect(loggedEvents(outlet.calls())).toEqual(['rate_limit.store_unavailable']);
    } finally {
      outlet.restore();
      vi.restoreAllMocks();
    }
  });
});

describe('壊れた設定は落とす (fail-closed)', () => {
  // 検査に使う主体
  const principal = {
    kind: 'agent',
    apiKeyId: 'key-1',
    tenantId: 't1',
    plan: Plan.pro,
    agent: { id: 'a1', status: 'active', provider: Provider.anthropic, model: 'm' },
  } as unknown as Principal;

  // 記録は毎テストで新しい memory の表にする
  let repos: Repositories & { store: MemoryStore };

  beforeEach(() => {
    repos = createMemoryRepos(new MemoryStore());
  });

  it.each([0, -1, 1.5, Number.NaN])(
    '窓の長さが %s なら落とす（制限が丸ごと消える）',
    async (windowMs) => {
      // 壊れた窓の長さを設定する
      setRateLimitOverridesForTesting({ limit: 10, windowMs });
      // **0 以下だと「どの記録も数えられず全部通る」** = レート制限が無言で消える
      await expect(enforceRateLimit(repos, principal, RATE_LIMIT_TIER.standard)).rejects.toThrow(
        RangeError,
      );
      // 記録も増えていない（通していない）
      expect(repos.store.rateLimitHits.size).toBe(0);
    },
  );

  it.each([0, -1, 1.5, Number.NaN])('共有の枠の上限が %s なら落とす', async (limit) => {
    // 壊れた上限を設定する
    setRateLimitOverridesForTesting({ limit });
    // 0 だと「全部断る」、負や小数だと比較が壊れる — どちらも渡す側のバグなので隠さない
    await expect(enforceRateLimit(repos, principal, RATE_LIMIT_TIER.standard)).rejects.toThrow(
      RangeError,
    );
  });

  it.each([0, -1, 1.5, Number.NaN])('追加の枠の上限が %s なら落とす', async (limit) => {
    // 共有は正しく、追加だけ壊す
    setRateLimitOverridesForTesting({ limit: 10 }, { limit });
    // 追加の枠を持つ種類で確かめる（持たない種類では `null` なので検証に入らない）
    await expect(enforceRateLimit(repos, principal, RATE_LIMIT_TIER.fanOut)).rejects.toThrow(
      RangeError,
    );
  });
});

describe('断ったときの待ち時間 (retryAfterSecondsFor)', () => {
  // 記録側の戻りを組み立てる補助
  function result(overrides: Partial<RateLimitConsumeResult>): RateLimitConsumeResult {
    // 既定は「どちらの枠も空・記録側の時計は T0」
    return {
      allowed: false,
      at: T0,
      contended: false,
      sharedCount: 0,
      extraCount: 0,
      sharedOldest: null,
      extraOldest: null,
      ...overrides,
    };
  }

  it('上限に達している枠の「最も古い記録が窓から外れるまで」を秒へ切り上げる', () => {
    // 共有が上限（1 件で上限 1）。最古は 1.5 秒前なので、残りは 58.5 秒 → 59 秒
    const seconds = retryAfterSecondsFor(
      result({ sharedCount: 1, sharedOldest: new Date(T0.getTime() - 1_500) }),
      WINDOW_MS,
      1,
      null,
    );
    expect(seconds).toBe(59);
  });

  it('両方の枠が埋まっていれば長いほうを返す', () => {
    // 共有の最古は 50 秒前（残り 10 秒）、追加の最古は 10 秒前（残り 50 秒）
    const seconds = retryAfterSecondsFor(
      result({
        sharedCount: 1,
        sharedOldest: new Date(T0.getTime() - 50_000),
        extraCount: 1,
        extraOldest: new Date(T0.getTime() - 10_000),
      }),
      WINDOW_MS,
      1,
      1,
    );
    // **短いほうを返すと、その時刻に再試行しても必ず断られる**
    expect(seconds).toBe(50);
  });

  it('上限に達していない枠は見ない（追加の枠だけが埋まっている場合）', () => {
    // 共有は余裕あり（1 件で上限 10）、追加だけが上限
    const seconds = retryAfterSecondsFor(
      result({
        sharedCount: 1,
        sharedOldest: new Date(T0.getTime() - 50_000),
        extraCount: 2,
        extraOldest: new Date(T0.getTime() - 10_000),
      }),
      WINDOW_MS,
      10,
      2,
    );
    // 共有の最古（残り 10 秒）ではなく追加の最古（残り 50 秒）を使う
    expect(seconds).toBe(50);
  });

  it('追加の枠を持たない種類では共有の枠だけを見る', () => {
    // `extraLimit` が null なら `extraCount` がいくつでも無視する
    const seconds = retryAfterSecondsFor(
      result({
        sharedCount: 1,
        sharedOldest: new Date(T0.getTime() - 30_000),
        extraCount: 99,
        extraOldest: new Date(T0.getTime() - 1_000),
      }),
      WINDOW_MS,
      1,
      null,
    );
    // 共有の最古（残り 30 秒）
    expect(seconds).toBe(30);
  });

  it('0 秒を返さない（最低 1 秒）', () => {
    // 最古がちょうど窓の端（残り 0 秒）でも 1 秒待たせる。**0 は「いますぐ再試行」に見えるので、
    // 同じ要求が即座に 429 で跳ね返る輪ができる**（delay-seconds は整数）
    const seconds = retryAfterSecondsFor(
      result({ sharedCount: 1, sharedOldest: new Date(T0.getTime() - WINDOW_MS) }),
      WINDOW_MS,
      1,
      null,
    );
    expect(seconds).toBe(1);
  });

  it('時計が巻き戻っても窓の長さを超えない', () => {
    // 最古が「未来」になっている（記録側の時計の巻き戻り）
    const seconds = retryAfterSecondsFor(
      result({ sharedCount: 1, sharedOldest: new Date(T0.getTime() + 5_000) }),
      WINDOW_MS,
      1,
      null,
    );
    // **素直に計算すると 65 秒になるので頭打ちにする。** どんな場合でも窓の長さだけ待てば
    // 必ず 1 回ぶんの空きができるので、それより長く待たせるのは素直に従うクライアントを
    // 理由なく止めることになる（以前の実装は `now` を初期値にした `reduce` で最小値を
    // 取っていたため構造的に起こりえず、移行で失われていた）
    expect(seconds).toBe(WINDOW_MS / 1_000);
  });

  it('最も古い記録が分からなければ最低値で答える（上限が壊れている場合の保険）', () => {
    // 件数は上限を超えているのに最古が null（記録が無いのに断られる状態）
    const seconds = retryAfterSecondsFor(result({ sharedCount: 0 }), WINDOW_MS, 0, null);
    expect(seconds).toBe(1);
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

describe('共有の枠の上限', () => {
  // 環境変数を組み立てる（NODE_ENV は ProcessEnv で必須）
  function env(value: string | undefined): NodeJS.ProcessEnv {
    // 指定された値だけを入れる
    return { NODE_ENV: 'test', [PROXY_RATE_LIMIT_ENV]: value } as NodeJS.ProcessEnv;
  }

  // プラン別の上限を見るための主体（テナントのユーザー）
  function userWith(plan: Plan): Principal {
    // 判定に要るのは kind / tenantId / plan だけ
    return {
      kind: 'user',
      tenantId: 'tn-1',
      plan,
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
    };
  }

  it('未設定なら上書き無し（null）', () => {
    // 未設定・空文字・空白だけはすべて上書き無し
    for (const value of [undefined, '', '   ']) {
      expect(rateLimitOverrideFromEnv(env(value))).toBeNull();
    }
  });

  it('正の整数なら上書きが効く（ベンチが計測を妨げられないようにする用途）', () => {
    // 前後の空白は落とす
    expect(rateLimitOverrideFromEnv(env('1234'))).toBe(1234);
    expect(rateLimitOverrideFromEnv(env(' 1234 '))).toBe(1234);
  });

  it.each([
    ['0（制限が丸ごと無効になる）', '0'],
    ['負の値', '-1'],
    ['小数', '1.5'],
    ['数値でない', 'たくさん'],
    ['指数表記でない混在', '12abc'],
    ['Infinity', 'Infinity'],
    ['NaN', 'NaN'],
  ])('読めない値は上書き無しへ倒す（fail-closed）: %s', (_label, value) => {
    // **設定ミスで制限が消えるより、プランの上限が効いている方が安全**
    expect(rateLimitOverrideFromEnv(env(value))).toBeNull();
  });

  it.each(Object.values(Plan))('%s のテナントはプランの上限で数える', (plan) => {
    // **プランの表が正本**（ここに数値を書き写さない）
    expect(sharedRateLimitFor(userWith(plan), env(undefined))).toBe(
      PLAN_LIMITS[plan].proxyRateLimitPerMinute,
    );
  });

  it('API キーの主体も同じプランの上限で数える（中継の経路）', () => {
    // 中継はエージェント主体で来るので、こちらも plan を読んでいること
    const agent: Principal = {
      kind: 'agent',
      tenantId: 'tn-1',
      apiKeyId: 'ak-1',
      plan: Plan.enterprise,
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
    };
    expect(sharedRateLimitFor(agent, env(undefined))).toBe(
      PLAN_LIMITS[Plan.enterprise].proxyRateLimitPerMinute,
    );
  });

  it('環境変数を設定するとプランの差が消える', () => {
    // ベンチのための逃げ道。**設定した配備先では全テナントが同じ上限になる**
    for (const plan of Object.values(Plan)) {
      expect(sharedRateLimitFor(userWith(plan), env('5000'))).toBe(5000);
    }
  });

  it('プラットフォーム管理者は最も厳しいプランへ倒す（fail-closed）', () => {
    // プランを持たない主体。**いま共有の枠を宣言しているルートは 4 本ともテナントの経路**なので
    // この分岐は実際には通らないが、通ったときに緩む側へ倒れないようにしてある
    expect(sharedRateLimitFor({ kind: 'platform' }, env(undefined))).toBe(
      PLAN_LIMITS[FALLBACK_PLAN].proxyRateLimitPerMinute,
    );
  });
});

describe('追加の枠の上限', () => {
  it('種類ごとの表から引き、持たない種類は null', () => {
    // 標準の枠は追加の枠を持たない
    expect(extraRateLimitFor(RATE_LIMIT_TIER.standard)).toBeNull();
  });

  it('表に無い種類は拒否する（`null` へ倒すと小さいほうの上限が黙って消える）', () => {
    // 型の外から届く値（`constructor` は `Object.prototype` 由来の値を返す綴り）。
    // **`null` へ倒してはいけない** — それは「追加の枠を持たない種類」と同じ意味なので、
    // その経路は共有の枠だけで守られる＝ fan-out や heavyRead の小さい上限が消える
    for (const bogus of ['constructor', 'valueOf', 'unknownTier'])
      expect(() => extraRateLimitFor(bogus as RateLimitTier)).toThrow(/種類/);
    // 残りの 3 種類は正の整数の上限を持つ（値そのものは constants.ts が正本）
    for (const tier of [
      RATE_LIMIT_TIER.fanOut,
      RATE_LIMIT_TIER.outbound,
      RATE_LIMIT_TIER.heavyRead,
    ]) {
      const limit = extraRateLimitFor(tier);
      expect(limit).not.toBeNull();
      expect(Number.isInteger(limit)).toBe(true);
      expect(limit as number).toBeGreaterThan(0);
    }
  });

  it('プラン別にしない（守っているのは 1 要求の重さそのもの）', () => {
    // 上位プランでも 1 要求の重さは変わらないので、主体を取らない形にしてある
    expect(extraRateLimitFor).toHaveLength(1);
  });
});
