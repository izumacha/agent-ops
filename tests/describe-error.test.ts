// `describeError` の挙動契約。**この関数が唯一の経路**なので、ここが緩むと全ログ経路が同時に緩む。
// 以前は担保が `tests/api/health.test.ts` の間接 1 件しかなく、実測で
// `return { type: typeof error }` に `value: String(error)` を足す変異が 842 件すべて緑を通った
import { describe, expect, it } from 'vitest';
import { describeError } from '@/lib/describe-error';

describe('describeError', () => {
  it('Error でない値は型だけを返す (値そのものを載せない)', () => {
    // 文字列を throw する経路（任意の値がそのままログへ出ないこと）
    expect(describeError('postgres://app:secret@db')).toEqual({ type: 'string' });
    // オブジェクトも同じ
    expect(describeError({ dsn: 'postgres://app:secret@db' })).toEqual({ type: 'object' });
    // null / undefined / 数値
    expect(describeError(null)).toEqual({ type: 'object' });
    expect(describeError(undefined)).toEqual({ type: 'undefined' });
    expect(describeError(42)).toEqual({ type: 'number' });
  });

  it('message は 1 文字も含めない (PII とクエリ引数の本体)', () => {
    // ORM の検証エラーを模した message（利用者の入力がそのまま埋まる形）
    const error = new Error("Invalid `prisma.user.findUnique()`: email='tanaka@example.com'");
    // 出力を文字列にして探す（どの項目に紛れても気付けるように）
    const dumped = JSON.stringify(describeError(error));
    expect(dumped).not.toContain('tanaka@example.com');
    expect(dumped).not.toContain('prisma.user.findUnique');
  });

  it('name と code は短い識別子のときだけ中身を載せる', () => {
    // 実在の形（Node のシステムエラー）はそのまま載る
    const system = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    expect(describeError(system)).toMatchObject({ name: 'Error', code: 'ECONNREFUSED' });
    // 接続文字列を code に入れた形は中身を出さない
    const dsn = Object.assign(new Error('boom'), { code: 'postgres://app:secret-pw@db' });
    expect(describeError(dsn)).toMatchObject({ code: { type: 'string' } });
    // 構造化された診断を code に入れた形も型だけ
    const structured = Object.assign(new Error('boom'), {
      code: { q: "SELECT * FROM users WHERE email='tanaka@example.com'" },
    });
    expect(JSON.stringify(describeError(structured))).not.toContain('tanaka@example.com');
    // name は書き換えられるので同じ規則で絞る
    const renamed = new Error('boom');
    renamed.name = 'tanaka@example.com';
    expect(describeError(renamed)).toMatchObject({ name: { type: 'string' } });
  });

  it('message 由来の行をスタックフレームとして載せない', () => {
    // message に偽のフレームを仕込む（改行を含む利用者の入力を模す）
    const error = new Error('boom\n    at 田中 (/etc/passwd:1:1)');
    // 見出しは name + message で固定されるので、長さで切り落とせる
    const frames = describeError(error).frames as string[];
    expect(frames.some((frame) => frame.includes('田中'))).toBe(false);
    // 本物のフレームは残っている（絞りすぎて診断が消えていないこと）
    expect(frames.length).toBeGreaterThan(0);
  });

  it('見出しを読めなければフレームを 1 行も出さず、その事実を残す (fail-closed)', () => {
    // stack を差し替えて見出しと合わない形にする
    const error = new Error('boom');
    error.stack = 'まったく別の見出し\n    at 田中 (/etc/passwd:1:1)';
    // 読めなかったことが分かる印が付き、フレームは空
    expect(describeError(error)).toMatchObject({ frames: [], stackUnparsed: true });
  });

  it('cause と AggregateError の中身は辿らない (連鎖で message が漏れない)', () => {
    // cause に PII 入りの message を持つ Error を繋ぐ
    const inner = new Error('email=tanaka@example.com');
    const outer = new Error('boom', { cause: inner });
    expect(JSON.stringify(describeError(outer))).not.toContain('tanaka@example.com');
    // AggregateError の errors も同じ
    const aggregate = new AggregateError([inner], 'boom');
    expect(JSON.stringify(describeError(aggregate))).not.toContain('tanaka@example.com');
  });
});
