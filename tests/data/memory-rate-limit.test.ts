// memory アダプタのレート制限の記録（ADR-0015）の検査。
//
// **窓の数え方はここが正本の実装**（以前は `src/lib/api/rate-limit.ts` のクラスが持っていた）。
// prisma 側は「助言ロック → 1 文の CTE」で同じことをするので、**同じ期待を契約テストにも書く**
// （`tests/data/rate-limit.contract.prisma.test.ts`。ADR-0006 の死角で、緩いと API テストだけが
// 「上限を超えても通る世界」で緑になる）。
//
// **時刻は表の時計（`MemoryStore.now()`）が決める**ので、ここでは時計を差し替えて境界を
// 決定的に動かす（実 DB 側は `statement_timestamp()` なので、ミリ秒単位の境界はこちらで固定する）。
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryRepos, MemoryStore } from '@/data/adapters/memory';
import type { Repositories } from '@/data/ports';

// 窓の長さ（1 分）
const WINDOW_MS = 60_000;
// 起点の時刻（絶対値には意味が無いが、固定して境界を読みやすくする）
const T0 = new Date('2026-10-09T00:00:00.000Z');
// 数える単位（偽装できない値を渡す約束なので、形だけそろえる）
const KEY = 'tenant:tn-1';
// 掃き出しで 1 回に消す件数の上限（境界が読みやすい小さい値）
const SWEEP_LIMIT = 100;

// 検査対象（毎テストで新しい表にする）
let repos: Repositories & { store: MemoryStore };
// 表の時計が返す時刻（テストが進める）
let clock: Date;

// 1 回の消費（時刻は表の時計が決めるので、進めたいときは `clock` を動かす）
function consume(options: {
  at?: Date;
  tier?: string;
  sharedLimit?: number;
  extraLimit?: number | null;
  key?: string;
}) {
  // 指定があれば表の時計を進める
  if (options.at !== undefined) clock = options.at;
  // 記録側へ渡す（判定と記録は 1 回の操作）
  return repos.rateLimit.consume({
    key: options.key ?? KEY,
    tier: options.tier ?? 'standard',
    windowMs: WINDOW_MS,
    sharedLimit: options.sharedLimit ?? 3,
    extraLimit: options.extraLimit ?? null,
  });
}

// 毎テストで新しい表にする（前のテストの記録が漏れない）
beforeEach(() => {
  repos = createMemoryRepos(new MemoryStore());
  // 時計を固定する（**差し替えてよいことは `MemoryStore.now` のコメントが約束している**）
  clock = T0;
  repos.store.now = () => clock;
});

describe('窓の中を数えて条件付きで 1 行足す', () => {
  it('上限までは通し、超えた分を断る', async () => {
    // 上限 3 なので 3 回通る
    for (let index = 0; index < 3; index += 1) {
      const result = await consume({ at: new Date(T0.getTime() + index) });
      expect(result.allowed, `${index + 1} 回目`).toBe(true);
      // 件数は**今回を足す前**の値
      expect(result.sharedCount).toBe(index);
    }
    // 4 回目は断る
    const denied = await consume({ at: new Date(T0.getTime() + 3) });
    expect(denied.allowed).toBe(false);
    expect(denied.sharedCount).toBe(3);
  });

  it('断った呼び出しは数えないので、窓が延びない', async () => {
    // 上限 1 を使い切る
    await consume({ sharedLimit: 1 });
    // 断られる呼び出しを何度も出す
    for (let index = 0; index < 5; index += 1) {
      const denied = await consume({ at: new Date(T0.getTime() + 1_000 + index), sharedLimit: 1 });
      expect(denied.allowed).toBe(false);
      // **件数は 1 のまま**（断った分を数えると、断られ続けるあいだ窓が延びて永久に通れない）
      expect(denied.sharedCount).toBe(1);
      // 最も古い記録も動かない（待ち時間が伸び続けない）
      expect(denied.sharedOldest?.getTime()).toBe(T0.getTime());
    }
  });

  it('窓は過去側が半開（ちょうど窓の長さだけ前の記録は外れている）', async () => {
    // 上限 1 を使い切る
    await consume({ sharedLimit: 1 });
    // ちょうど窓の長さだけ進めると、その記録は窓の下端と同値になり**外れる**
    const justOut = await consume({ at: new Date(T0.getTime() + WINDOW_MS), sharedLimit: 1 });
    expect(justOut.allowed).toBe(true);
    expect(justOut.sharedCount).toBe(0);
  });

  it('1 ミリ秒足りなければまだ窓の中', async () => {
    // 上限 1 を使い切る
    await consume({ sharedLimit: 1 });
    // 窓の長さより 1 ミリ秒手前では、まだ数えられる
    const stillIn = await consume({ at: new Date(T0.getTime() + WINDOW_MS - 1), sharedLimit: 1 });
    expect(stillIn.allowed).toBe(false);
    expect(stillIn.sharedCount).toBe(1);
  });

  it('キーごとに枠が独立している', async () => {
    // 片方のキーで上限 1 を使い切る
    await consume({ sharedLimit: 1 });
    // 別のキーはまだ通る（他人の呼び出しで断られない）
    const other = await consume({ key: 'tenant:tn-2', sharedLimit: 1 });
    expect(other.allowed).toBe(true);
    expect(other.sharedCount).toBe(0);
  });

  it('期限切れの記録はその場で掃かれる（表が膨らみ続けない）', async () => {
    // 3 件入れる
    for (let index = 0; index < 3; index += 1) {
      await consume({ at: new Date(T0.getTime() + index) });
    }
    // 表には 3 件ある
    expect(repos.store.rateLimitHits.get(KEY)).toHaveLength(3);
    // 3 件すべてが窓から外れる時刻（下端が T0+10 になるので T0・T0+1・T0+2 はすべて外れる）で
    // 1 回叩くと、古い 3 件は落ちて新しい 1 件だけになる
    await consume({ at: new Date(T0.getTime() + WINDOW_MS + 10) });
    expect(repos.store.rateLimitHits.get(KEY)).toHaveLength(1);
  });

  it('追加の枠は同じ記録を種類で絞って数える（置き換えではなく「加えて」消費する）', async () => {
    // 共有 10 / 追加 2 で、追加の枠を持つ種類を 2 回通す
    for (let index = 0; index < 2; index += 1) {
      const result = await consume({
        at: new Date(T0.getTime() + index),
        tier: 'fanOut',
        sharedLimit: 10,
        extraLimit: 2,
      });
      expect(result.allowed).toBe(true);
    }
    // 3 回目は**共有にまだ余裕があるのに**追加の枠で断られる
    const denied = await consume({ tier: 'fanOut', sharedLimit: 10, extraLimit: 2 });
    expect(denied.allowed).toBe(false);
    expect(denied.sharedCount).toBe(2);
    expect(denied.extraCount).toBe(2);
    // **同じ行が共有の枠にも入っている** — 別の種類から見ると共有は 2 件、その種類は 0 件
    const standard = await consume({ tier: 'standard', sharedLimit: 10, extraLimit: null });
    expect(standard.allowed).toBe(true);
    expect(standard.sharedCount).toBe(2);
    expect(standard.extraCount).toBe(0);
  });

  it('共有の枠が尽きていれば、追加の枠に余裕があっても断る', async () => {
    // 共有 1 を使い切る
    await consume({ sharedLimit: 1 });
    // 追加の枠は 5 件空いているが、共有が尽きているので断る
    const denied = await consume({ tier: 'fanOut', sharedLimit: 1, extraLimit: 5 });
    expect(denied.allowed).toBe(false);
    expect(denied.extraCount).toBe(0);
    // **断ったので追加の枠にも 1 件も入っていない**（片方だけ消費された状態を作らない）
    expect(repos.store.rateLimitHits.get(KEY)).toHaveLength(1);
  });

  it('最も古い記録は最小値で返す（時計が巻き戻っても待ち時間が伸びない）', async () => {
    // 上限 3。**2 件目を 1 件目より古い時刻で入れる**（NTP の巻き戻りを模す）
    await consume({ at: new Date(T0.getTime() + 5_000) });
    await consume({ at: T0 });
    // 3 件目の判定で返る「最も古い記録」は push 順の先頭ではなく最小値
    const result = await consume({ at: new Date(T0.getTime() + 6_000) });
    expect(result.sharedOldest?.getTime()).toBe(T0.getTime());
  });
});

describe('時刻の出どころ', () => {
  it('記録側の時計が「いま」を決め、使った値を返す（呼び出し側は渡さない）', async () => {
    // 表の時計を進めてから数える
    const result = await consume({ at: new Date(T0.getTime() + 1_234) });
    // **返ってきた `at` は表の時計の値**（アプリの時計ではない）
    expect(result.at.getTime()).toBe(T0.getTime() + 1_234);
    // 入った行も同じ時刻
    expect(repos.store.rateLimitHits.get(KEY)?.[0]?.at.getTime()).toBe(T0.getTime() + 1_234);
  });

  it('混雑による打ち切りは起きない（単一スレッドなので割り込まれない）', async () => {
    // memory アダプタは `await` を 1 つも持たないので、判定の途中へ別の呼び出しが入れない
    const result = await consume({});
    expect(result.contended).toBe(false);
  });
});

describe('窓から外れた記録の掃き出し (sweep)', () => {
  // **渡すのは窓の長さで、境目は表の時計が決める**（prisma が `statement_timestamp()` で
  // 決めるのと同じ分担。理由は Port の `sweep`）。この検査では `now` を固定しているので、
  // 「`now` から何ミリ秒前より古い行を消すか」を直に書ける
  it('期限切れだけを消し、消した件数を返す', async () => {
    // 2 つのキーに 2 件ずつ入れる
    for (const key of [KEY, 'tenant:tn-2']) {
      await consume({ key, at: T0 });
      await consume({ key, at: new Date(T0.getTime() + 30_000) });
    }
    // 表の時計を 60 秒先へ進め、窓を 31 秒にすると T0 の行だけが外れる
    clock = new Date(T0.getTime() + 60_000);
    const deleted = await repos.rateLimit.sweep(31_000, SWEEP_LIMIT);
    // 2 キー × 1 件
    expect(deleted).toBe(2);
    // 新しいほうは残っている
    expect(repos.store.rateLimitHits.get(KEY)).toHaveLength(1);
  });

  it('1 件も残らないキーは表から消える（二度と来ないキーを抱え続けない）', async () => {
    // 1 件だけ入れる
    await consume({ at: T0 });
    // 表の時計を進めて、その行が窓から外れるようにする
    clock = new Date(T0.getTime() + 60_000);
    const deleted = await repos.rateLimit.sweep(1_000, SWEEP_LIMIT);
    expect(deleted).toBe(1);
    // **キーごと消えている**（これが sweep の目的）
    expect(repos.store.rateLimitHits.has(KEY)).toBe(false);
  });

  it('1 回で消す件数には上限がある（長い DELETE と大きなロックを作らない）', async () => {
    // 5 件入れる（すべて同じ時刻以前）
    for (let index = 0; index < 5; index += 1) {
      await consume({ at: new Date(T0.getTime() + index), sharedLimit: 10 });
    }
    // 表の時計を進めて 5 件すべてを窓の外に出す
    clock = new Date(T0.getTime() + 60_000);
    // 上限 2 で掃くと 2 件だけ消える
    expect(await repos.rateLimit.sweep(1_000, 2)).toBe(2);
    // 残りは 3 件（呼び出し側は「上限未満が返るまで」繰り返す）
    expect(repos.store.rateLimitHits.get(KEY)).toHaveLength(3);
    // 続けて呼べば残りも消える
    expect(await repos.rateLimit.sweep(1_000, 2)).toBe(2);
    expect(await repos.rateLimit.sweep(1_000, 2)).toBe(1);
    expect(repos.store.rateLimitHits.has(KEY)).toBe(false);
  });

  it('消すものが無ければ 0 を返す（何度呼んでも安全）', async () => {
    // 記録を 1 件入れ、まだ窓の中であるうちに掃く
    await consume({ at: T0 });
    expect(await repos.rateLimit.sweep(60_000, SWEEP_LIMIT)).toBe(0);
    // 記録はそのまま
    expect(repos.store.rateLimitHits.get(KEY)).toHaveLength(1);
  });

  it('境目はアプリの時計ではなく表の時計が決める（表が先を指していても消す）', async () => {
    // **表の時計を実時刻より先へ置く。** ここが要点で、「生きている記録を消さない」側は
    // すぐ上の「消すものが無ければ 0 を返す」が既に固定している（T0 は実時刻より前なので、
    // 境目を実時刻から決める実装ではあの行が消えて落ちる）。こちらは**逆向き＝消し残し**を見る:
    // 実時刻から決めると「まだ未来の行」は境目より新しいので**永久に消えない**（二度と来ない
    // キーの行を回収するというこの掃きの目的そのものが果たせなくなる）
    const ahead = new Date(Date.now() + 60 * 60_000);
    // 先の時刻で 1 件入れる
    await consume({ at: ahead });
    // 表の時計だけを窓の長さの 2 倍進める（表から見れば窓の外、実時刻から見ればまだ未来）
    clock = new Date(ahead.getTime() + WINDOW_MS * 2);
    // 表の時計が決めるので消える
    expect(await repos.rateLimit.sweep(WINDOW_MS, SWEEP_LIMIT)).toBe(1);
    expect(repos.store.rateLimitHits.has(KEY)).toBe(false);
  });
});
