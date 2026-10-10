// レート制限の記録（ADR-0015）の契約テスト（実 PostgreSQL）。
//
// **memory アダプタでは見えないもの**をここで固定する:
//   - 1 文の CTE（掃く → 数える → 条件付きで足す）が実 DB で意図どおりの順に効くこと
//   - `FILTER` を使った「種類ごとの数」が同じ走査から出ること
//   - **時刻が DB の時計で決まること**（アプリのインスタンスごとの壁時計を使うと、記録が
//     配備全体で 1 つでも時刻がずれた台数ぶん枠が割れる）
//   - **同じキーの判定が助言ロックで直列化され、順番待ちは短く打ち切られること**
//     （1 文の CTE だけでは READ COMMITTED のスナップショットのせいで同時実行に対して緩む）
//   - 一括の掃き出しが窓から外れた行だけを、**件数の上限まで**消すこと
//
// **ミリ秒単位の窓の境界はここでは見ない** — 時刻は DB が決めるので、テストから「ちょうど窓の
// 長さだけ前」を作れない。境界は memory 側（時計を差し替えられる）が固定する。
// RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で全テーブルを TRUNCATE するため開発 DB を指さない
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Repositories } from '@/data/ports';
import { runContractDatabaseGuard } from '../../scripts/lib/contract-database.mjs';

// 明示フラグが無ければ丸ごとスキップする
const ENABLED = process.env.RUN_PRISMA_CONTRACT === '1';

// 窓の長さ（1 分）。実時刻で走るので、テストの実行時間より十分長い値にする
const WINDOW_MS = 60_000;
// 数える単位
const KEY = 'tenant:contract';
// 掃き出しで 1 回に消す件数の上限
const SWEEP_LIMIT = 100;
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

  // 1 回の消費（時刻は DB の時計が決めるので、こちらからは渡さない）
  function consume(options: {
    tier?: string;
    sharedLimit?: number;
    extraLimit?: number | null;
    key?: string;
  }) {
    // 既定は「標準の枠・共有 3・追加なし」
    return repos.rateLimit.consume({
      key: options.key ?? KEY,
      tier: options.tier ?? 'standard',
      windowMs: WINDOW_MS,
      sharedLimit: options.sharedLimit ?? 3,
      extraLimit: options.extraLimit ?? null,
    });
  }

  // 表に残っている件数
  async function storedRows(): Promise<number> {
    // 索引を使わない数え上げだが、テストの行数は小さい
    return await client.rateLimitHit.count();
  }

  // 指定した秒数だけ過去の時刻で 1 行直接入れる（**DB の時計で**。アプリの時計を混ぜない）
  async function insertHitSecondsAgo(seconds: number, tier = 'standard'): Promise<void> {
    // `statement_timestamp()` から引くので、アプリ側の時刻は 1 度も使わない
    await client.$executeRaw`
      INSERT INTO "RateLimitHit" ("key", "tier", "at")
      VALUES (${KEY}, ${tier}, statement_timestamp() - make_interval(secs => ${seconds}::double precision))
    `;
  }

  it('上限までは通し、超えた分を断る（件数は今回を足す前の値）', async () => {
    // 上限 3 なので 3 回通る
    for (let index = 0; index < 3; index += 1) {
      const result = await consume({});
      expect(result.allowed, `${index + 1} 回目`).toBe(true);
      expect(result.sharedCount).toBe(index);
    }
    // 4 回目は断り、**行は増えていない**
    const denied = await consume({});
    expect(denied.allowed).toBe(false);
    expect(denied.contended).toBe(false);
    expect(denied.sharedCount).toBe(3);
    expect(await storedRows()).toBe(3);
  });

  it('窓から外れた記録は数えず、同じ操作の中で掃く', async () => {
    // 窓の長さより古い行を 2 件入れる（DB の時計で）
    await insertHitSecondsAgo(WINDOW_MS / 1_000 + 10);
    await insertHitSecondsAgo(WINDOW_MS / 1_000 + 20);
    // 上限 1 でも通る（古い 2 件は窓の外）
    const result = await consume({ sharedLimit: 1 });
    expect(result.allowed).toBe(true);
    expect(result.sharedCount).toBe(0);
    // **期限切れは同じ文の中で掃かれている**（残るのは新しい 1 件だけ）
    expect(await storedRows()).toBe(1);
  });

  it('窓の中の記録は数える', async () => {
    // 窓の半分だけ前の行を 1 件入れる
    await insertHitSecondsAgo(WINDOW_MS / 2_000);
    // 上限 1 なら断られる（窓の中に 1 件ある）
    const result = await consume({ sharedLimit: 1 });
    expect(result.allowed).toBe(false);
    expect(result.sharedCount).toBe(1);
  });

  it('追加の枠は同じ記録を種類で絞って数える（FILTER が同じ走査から出す）', async () => {
    // 共有 10 / 追加 2 の種類を 2 回通す
    for (let index = 0; index < 2; index += 1) {
      await consume({ tier: 'fanOut', sharedLimit: 10, extraLimit: 2 });
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
    // 古い順に 2 件入れる（どちらも窓の中）
    await insertHitSecondsAgo(30);
    await insertHitSecondsAgo(10);
    // 上限 2 で判定すると断られ、最古は 30 秒前のほう
    const result = await consume({ sharedLimit: 2 });
    expect(result.allowed).toBe(false);
    // 30 秒前 ±2 秒（実時刻で走るので幅を持たせる）
    const ageMs = result.at.getTime() - (result.sharedOldest?.getTime() ?? 0);
    expect(ageMs).toBeGreaterThan(28_000);
    expect(ageMs).toBeLessThan(32_000);
  });

  // **時刻の出どころが DB であること。** アプリの時計を使うと、記録が配備全体で 1 つでも
  // 時刻がずれた台数ぶん枠が割れる（90 秒遅れているインスタンスが入れた行は、進んでいる
  // インスタンスの窓から外れて数えられない）。ADR-0015 が閉じた穴が時刻の側から戻ってくる
  it('「いま」は DB の時計が決める（アプリの時計とは独立）', async () => {
    // DB の時計を直接読む
    const [before] = await client.$queryRaw<{ now: Date }[]>`SELECT statement_timestamp() AS "now"`;
    // 数える
    const result = await consume({});
    // DB の時計を再び読む
    const [after] = await client.$queryRaw<{ now: Date }[]>`SELECT statement_timestamp() AS "now"`;
    // **返ってきた `at` は 2 つの間にある**（アプリの `new Date()` ではなく DB の時刻）
    expect(result.at.getTime()).toBeGreaterThanOrEqual(before!.now.getTime());
    expect(result.at.getTime()).toBeLessThanOrEqual(after!.now.getTime());
    // 入った行の時刻も同じ値（`at` を 2 回評価していない）
    const [row] = await client.$queryRaw<{ at: Date }[]>`SELECT "at" FROM "RateLimitHit"`;
    expect(row!.at.getTime()).toBe(result.at.getTime());
  });

  // **これが契約テストの本体**。判定と記録を 1 文の CTE に収めるだけでは足りない —
  // READ COMMITTED では文のスナップショットが文の開始時点で固まるので、同時に走った別の文の
  // 挿入が見えない（実測: ロックを外した実装で、上限 3 に対して 10 本同時に投げると 6 本が通った）。
  //
  // **「同時に N 本投げて通ったのは上限ぶんか」では見張れない。** 実測で、本数を 30 へ増やすと
  // ロックを外した実装でもちょうど 3 本になった — 同時に*実際に*走る本数は接続プールの大きさで
  // 決まるので、本数を増やすほど待ち行列ができて直列に近づく（検出力が本数に比例しない）。
  // そこで**ロックそのものを別の接続から掴んで**、判定が「待って、打ち切って、断る」ことを見る
  it('同じキーの助言ロックを掴んでいる間は、数えずに断る（contended）', async () => {
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
    try {
      // **待って、打ち切って、断る**（ロックを取っていなければ `allowed: true` が返る）
      const result = await consume({ sharedLimit: 3 });
      expect(result.allowed, 'ロックを無視して通している').toBe(false);
      expect(result.contended, '順番待ちの打ち切りとして報告していない').toBe(true);
      // **数えていないので件数も最古も持たない**（上限超過と区別できる）
      expect(result.sharedCount).toBe(0);
      expect(result.sharedOldest).toBeNull();
      // **行は 1 本も増えていない**
      expect(await storedRows()).toBe(0);
    } finally {
      // 失敗しても必ず離す（掴んだまま抜けると、次のテストの TRUNCATE が道連れで落ちる）
      release();
      await holding;
    }
    // ロックを離した後は通る
    const afterRelease = await consume({ sharedLimit: 3 });
    expect(afterRelease.allowed).toBe(true);
    expect(afterRelease.contended).toBe(false);
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
      expect(result.contended).toBe(false);
    } finally {
      release();
      await holding;
    }
  });

  it('掃き出しは窓から外れた行だけを、件数の上限まで消す', async () => {
    // 古い行を 5 件、新しい行を 1 件入れる
    for (let index = 0; index < 5; index += 1) await insertHitSecondsAgo(300 + index);
    await insertHitSecondsAgo(1);
    // **渡すのは窓の長さだけ**（境目は DB の時計が決める。理由は Port の `sweep`）。
    // 窓を 100 秒にすると、300 秒前の 5 件が外れて 1 秒前の 1 件は窓の中
    const windowMs = 100_000;
    expect(await repos.rateLimit.sweep(windowMs, 2)).toBe(2);
    // 残りは 4 件（古い 3 件 + 新しい 1 件）
    expect(await storedRows()).toBe(4);
    // 続けて呼べば古い分だけが消え、新しい行は残る
    expect(await repos.rateLimit.sweep(windowMs, SWEEP_LIMIT)).toBe(3);
    expect(await storedRows()).toBe(1);
    // 消すものが無ければ 0（何度呼んでも安全）
    expect(await repos.rateLimit.sweep(windowMs, SWEEP_LIMIT)).toBe(0);
  });

  it('窓の中の行は消さない（境目の向きが逆になっていないこと）', async () => {
    // 1 秒前の行を 1 件（窓の中）
    await insertHitSecondsAgo(1);
    // 窓の長さだけを渡して掃く（1 件も消えない）
    expect(await repos.rateLimit.sweep(60_000, SWEEP_LIMIT)).toBe(0);
    expect(await storedRows()).toBe(1);
  });

  // **「境目を決めるのが DB の時計か」はここでは確かめられない。**
  // このテストのプロセスと PostgreSQL は同じホストで動くので時計が一致し、
  // `statement_timestamp()` を `${new Date()}` へ差し替える変異は**契約テスト 10 件すべて緑**で
  // 通った（実測。`tests/raw-sql.test.ts` が同じ記録を持つ）。その性質を見ているのは
  // あちらの構文の網（SQL が時刻を DB に尋ねているかを見る）と、memory 側の
  // 「表の時計を進めると消える」なので、**ここの名前にその保証を書かない**
  // （書くと、読んだ人が本当の網を冗長だと判断して消しうる）。

  it('テナントを消しても記録は残る（業務データではないので FK を張っていない）', async () => {
    // テナントの枠として 1 件入れる
    await consume({ key: 'tenant:gone' });
    // テナントの表を空にする（解約を模す）
    await client.$executeRaw`TRUNCATE TABLE "Tenant" CASCADE`;
    // **記録は残る**（FK が無いので Cascade されない）。窓から外れた時点で掃かれる設計
    expect(await storedRows()).toBe(1);
  });
});
