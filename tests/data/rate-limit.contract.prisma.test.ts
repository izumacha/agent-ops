// レート制限の記録（ADR-0015）の契約テスト（実 PostgreSQL）。
//
// **memory アダプタでは見えないもの**をここで固定する:
//   - 1 文の CTE（掃く → 数える → 条件付きで足す）が実 DB で意図どおりの順に効くこと
//     （`purge` の DELETE が同じ文の集計に影響しないこと＝スナップショットの前提）
//   - `FILTER` を使った「種類ごとの数」が同じ走査から正しく出ること
//   - **同時に届いた 2 本で上限を超えないこと**（判定と記録を分けた形との違いは、
//     同時性のテストでしか見えない）
//   - 一括の掃き出し（`deleteMany`）が窓から外れた行だけを消すこと
// RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で全テーブルを TRUNCATE するため開発 DB を指さない
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Repositories } from '@/data/ports';
import { runContractDatabaseGuard } from '../../scripts/lib/contract-database.mjs';

// 明示フラグが無ければ丸ごとスキップする
const ENABLED = process.env.RUN_PRISMA_CONTRACT === '1';

// 窓の長さ（1 分）
const WINDOW_MS = 60_000;
// 起点の時刻（絶対値には意味が無いが、固定して境界を読みやすくする）
const T0 = new Date('2026-10-09T00:00:00.000Z');
// 数える単位
const KEY = 'tenant:contract';
// ロックの存在を確かめるときの待ち時間（これだけ待っても終わらなければ「待たされている」）
const LOCK_TEST_WAIT_MS = 500;
// ロックを掴んだままにするトランザクションの上限（既定の 5 秒だと待ちの間に時間切れになる）
const LOCK_TEST_TRANSACTION_TIMEOUT_MS = 10_000;

describe.skipIf(!ENABLED)('レート制限の記録の契約', () => {
  // 実 DB のクライアントとリポジトリ（本番と同じ Composition Root 経由）
  let client: typeof import('@/lib/prisma').prisma;
  let repos: Repositories;

  // 接続する（生成物へ依存するモジュールはここで初めて読む）
  beforeAll(async () => {
    // 接続先が専用 DB であること（TRUNCATE する前に確かめる）
    runContractDatabaseGuard();
    const [{ prisma }, { getRepos }] = await Promise.all([
      import('@/lib/prisma'),
      import('@/data'),
    ]);
    client = prisma;
    repos = await getRepos();
  });

  // 記録だけを空にする（**テナントに属さない表**なので Tenant の CASCADE では消えない）
  beforeEach(async () => {
    await client.$executeRaw`TRUNCATE TABLE "RateLimitHit"`;
  });

  // 1 回の消費（窓の下端は `now - 窓の長さ`）
  function consume(options: {
    now?: Date;
    tier?: string;
    sharedLimit?: number;
    extraLimit?: number | null;
    key?: string;
  }) {
    // 既定は「起点の時刻・標準の枠・共有 3・追加なし」
    const now = options.now ?? T0;
    return repos.rateLimit.consume({
      key: options.key ?? KEY,
      tier: options.tier ?? 'standard',
      windowStart: new Date(now.getTime() - WINDOW_MS),
      now,
      sharedLimit: options.sharedLimit ?? 3,
      extraLimit: options.extraLimit ?? null,
    });
  }

  // 表に残っている件数
  async function storedRows(): Promise<number> {
    // 索引を使わない数え上げだが、テストの行数は小さい
    return await client.rateLimitHit.count();
  }

  it('上限までは通し、超えた分を断る（件数は今回を足す前の値）', async () => {
    // 上限 3 なので 3 回通る
    for (let index = 0; index < 3; index += 1) {
      const result = await consume({ now: new Date(T0.getTime() + index) });
      expect(result.allowed, `${index + 1} 回目`).toBe(true);
      expect(result.sharedCount).toBe(index);
    }
    // 4 回目は断り、**行は増えていない**
    const denied = await consume({ now: new Date(T0.getTime() + 3) });
    expect(denied.allowed).toBe(false);
    expect(denied.sharedCount).toBe(3);
    expect(await storedRows()).toBe(3);
  });

  it('窓は過去側が半開（ちょうど窓の長さだけ前の記録は外れている）', async () => {
    // 上限 1 を使い切る
    await consume({ sharedLimit: 1 });
    // ちょうど窓の長さだけ進めると、その記録は窓の下端と同値になり外れる
    const justOut = await consume({ now: new Date(T0.getTime() + WINDOW_MS), sharedLimit: 1 });
    expect(justOut.allowed).toBe(true);
    expect(justOut.sharedCount).toBe(0);
    // **期限切れは同じ文の中で掃かれている**（残るのは新しい 1 件だけ）
    expect(await storedRows()).toBe(1);
  });

  it('追加の枠は同じ記録を種類で絞って数える（FILTER が同じ走査から出す）', async () => {
    // 共有 10 / 追加 2 の種類を 2 回通す
    for (let index = 0; index < 2; index += 1) {
      await consume({
        now: new Date(T0.getTime() + index),
        tier: 'fanOut',
        sharedLimit: 10,
        extraLimit: 2,
      });
    }
    // 3 回目は共有に余裕があるのに追加の枠で断られる
    const denied = await consume({ tier: 'fanOut', sharedLimit: 10, extraLimit: 2 });
    expect(denied.allowed).toBe(false);
    expect(denied.sharedCount).toBe(2);
    expect(denied.extraCount).toBe(2);
    // 別の種類から見ると共有は 2 件・その種類は 0 件（同じ行が両方の数に入っている）
    const standard = await consume({ tier: 'standard', sharedLimit: 10, extraLimit: null });
    expect(standard.allowed).toBe(true);
    expect(standard.sharedCount).toBe(2);
    expect(standard.extraCount).toBe(0);
  });

  it('最も古い記録を返す（断ったときの待ち時間の根拠）', async () => {
    // 2 件入れる（挿入順と時刻の順を**わざと逆**にする）
    await consume({ now: new Date(T0.getTime() + 5_000), sharedLimit: 3 });
    await consume({ now: T0, sharedLimit: 3 });
    // 上限 2 で判定すると、最古は最小値（挿入順の先頭ではない）
    const result = await consume({ now: new Date(T0.getTime() + 6_000), sharedLimit: 2 });
    expect(result.allowed).toBe(false);
    expect(result.sharedOldest?.getTime()).toBe(T0.getTime());
  });

  // **これが契約テストの本体**。判定と記録を 1 文の CTE に収めるだけでは足りない —
  // READ COMMITTED では文のスナップショットが文の開始時点で固まるので、同時に走った別の文の
  // 挿入が見えない（実測: ロックを外した実装で、上限 3 に対して 10 本同時に投げると 6 本が通った）。
  //
  // **「同時に N 本投げて通ったのは上限ぶんか」では見張れない。** 実測で、本数を 30 へ増やすと
  // ロックを外した実装でもちょうど 3 本になった — 同時に*実際に*走る本数は接続プールの大きさで
  // 決まるので、本数を増やすほど待ち行列ができて直列に近づく（検出力が本数に比例しない）。
  // そこで**ロックそのものの存在を決定的に確かめる**（エージェント数の上限と同じ手口）
  it('同じキーの助言ロックを掴んでいる間、数えるのは待たされる', async () => {
    // ロックを離す合図
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    // ロックを掴んだ合図（掴む前に数え始めると、どちらが先に取るかは運になり誤った赤が出る）
    let signalHeld = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    // 別のトランザクションで同じキーの助言ロックを掴んだまま待つ
    const holding = client.$transaction(
      async (tx) => {
        // `consume` が取るのと同じロック（同じキーの `hashtext`）
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${KEY}))`;
        // 掴めたことを知らせる
        signalHeld();
        // 合図が来るまで保持する
        await released;
      },
      { timeout: LOCK_TEST_TRANSACTION_TIMEOUT_MS },
    );
    // 掴むまで数え始めない
    await held;
    // 数え始める（ロックを取っていれば、掴んでいる間は終わらない）
    const consuming = consume({ sharedLimit: 3 });
    try {
      // 待たされていること（先に時間切れの方が返る）
      const finishedFirst = await Promise.race([
        consuming.then(() => 'counted' as const),
        new Promise<'blocked'>((resolve) =>
          setTimeout(() => resolve('blocked'), LOCK_TEST_WAIT_MS),
        ),
      ]);
      expect(finishedFirst).toBe('blocked');
    } finally {
      // 失敗しても必ず離す（掴んだまま抜けると、次のテストの TRUNCATE が道連れで落ちる）
      release();
      await holding;
    }
    // ロックを離した後は通る
    expect((await consuming).allowed).toBe(true);
  });

  it('別のキーなら待たされない（テナントをまたいで直列化しない）', async () => {
    // ロックを離す合図
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 掴んだ合図
    let signalHeld = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    // 別のキーのロックを掴む
    const holding = client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('tenant:unrelated'))`;
        signalHeld();
        await released;
      },
      { timeout: LOCK_TEST_TRANSACTION_TIMEOUT_MS },
    );
    await held;
    try {
      // **別のキーは独立**（1 テナントの混雑が他のテナントを止めない）
      const result = await consume({ sharedLimit: 3 });
      expect(result.allowed).toBe(true);
    } finally {
      release();
      await holding;
    }
  });

  it('掃き出しは窓から外れた行だけを消す（キーで絞らない）', async () => {
    // 2 つのキーに 2 件ずつ入れる
    for (const key of [KEY, 'tenant:other']) {
      await consume({ key, now: T0 });
      await consume({ key, now: new Date(T0.getTime() + 30_000) });
    }
    // 古いほうだけを対象にする（T0 を含む = lte）
    expect(await repos.rateLimit.sweep(T0)).toBe(2);
    // 新しいほうは残っている
    expect(await storedRows()).toBe(2);
    // 消すものが無ければ 0（何度呼んでも安全）
    expect(await repos.rateLimit.sweep(T0)).toBe(0);
  });

  it('テナントを消しても記録は残る（業務データではないので FK を張っていない）', async () => {
    // テナントの枠として 1 件入れる
    await consume({ key: 'tenant:gone' });
    // テナントの表を空にする（解約を模す）
    await client.$executeRaw`TRUNCATE TABLE "Tenant" CASCADE`;
    // **記録は残る**（FK が無いので Cascade されない）。窓から外れた時点で掃かれる設計
    expect(await storedRows()).toBe(1);
  });
});
