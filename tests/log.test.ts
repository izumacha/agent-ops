// ログの出口（src/lib/log.ts）の挙動を固定する。
//
// **検出網（tests/error-logging.test.ts）は「配線されているか」を構文で見るだけ**なので、
// これが無いと `formatLogLine` の中身を空にしても、カウンタを数えるのをやめても全件緑で通る
// （守備範囲を移した先が無検証だと、検出網の中心が空洞になる。このリポジトリが
// `assertApiVersionSupported` で踏んだのと同じ形）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOG_EVENTS, formatLogLine, logEvent } from '@/lib/log';
import { renderMetrics, resetMetricsForTesting } from '@/lib/metrics';
import { describeError } from '@/lib/describe-error';

// console へ出た行を集める
let lines: string[] = [];

beforeEach(() => {
  // カウンタを空へ戻す（前のテストを引きずらない）
  resetMetricsForTesting();
  lines = [];
  // 出口が呼ぶ console.error を捕まえる（実引数は 1 つだけのはず）
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ログ 1 行の形', () => {
  it('時刻・深刻度・出来事・説明を持つ 1 行の JSON になる', () => {
    // 診断なしの出来事を組み立てる
    const line = formatLogLine('plan.unknown_plan', undefined, new Date('2026-10-09T01:02:03Z'));
    // JSON として読める
    const parsed: unknown = JSON.parse(line);
    // 4 項目がそろう（警報の条件に使うのは `event`）
    expect(parsed).toEqual({
      ts: '2026-10-09T01:02:03.000Z',
      level: 'warn',
      event: 'plan.unknown_plan',
      message: LOG_EVENTS['plan.unknown_plan'].message,
    });
  });

  it('診断があれば error に添え、無ければ鍵そのものを出さない', () => {
    // 診断つき（**同じ診断を比べる** — `describeError` は発生箇所を載せるので、
    // 例外を 2 回作ると行番号が違って比較が成立しない）
    const described = describeError(new Error('boom'));
    const withError: Record<string, unknown> = JSON.parse(
      formatLogLine('prisma.pool_error', described),
    );
    expect(withError.error).toEqual(described);
    // 診断なし（`error` の鍵が無いことまで見る。null を入れると解析側が分岐を増やす）
    const withoutError: Record<string, unknown> = JSON.parse(formatLogLine('plan.unknown_plan'));
    expect('error' in withoutError).toBe(false);
  });

  it('1 行に収まる（改行を含まない）', () => {
    // 行指向のログ収集に載せるので、1 出来事 = 1 行であることが前提
    expect(formatLogLine('api.unexpected_error', describeError(new Error('a\nb')))).not.toContain(
      '\n',
    );
  });

  it('JSON にできない診断でも例外を投げず、最小の行へ縮退する', () => {
    // **絶対に投げてはいけない** — `catch` の中で呼ばれるので、投げると本来の失敗が別の失敗に化ける。
    // 循環参照は JSON.stringify が投げる代表例（BigInt も同じ）
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    // 投げずに文字列が返る
    const line = formatLogLine('api.unexpected_error', circular);
    // 診断を落としても出来事の識別子は残る（何が起きたかは分かる）
    expect(JSON.parse(line)).toEqual({
      ts: expect.any(String),
      level: 'error',
      event: 'api.unexpected_error',
      message: LOG_EVENTS['api.unexpected_error'].message,
    });
  });
});

describe('出来事を出す', () => {
  it('console へ 1 行だけ出す', () => {
    // 1 件出す
    logEvent('notify.send_failed');
    // 行は 1 本で、JSON として読める
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ event: 'notify.send_failed' });
  });

  it('出すと同時に数える（ログとメトリクスが食い違わない）', () => {
    // **出口とカウンタを同じ関数に置いてある**ので、ここが落ちたら結線が外れている
    logEvent('notify.send_failed');
    logEvent('notify.send_failed');
    logEvent('plan.unknown_plan');
    // 深刻度もラベルに入る（語彙が持つ値をそのまま使う）
    const text = renderMetrics(new Date());
    expect(text).toContain('agentops_log_events_total{event="notify.send_failed",level="error"} 2');
    expect(text).toContain('agentops_log_events_total{event="plan.unknown_plan",level="warn"} 1');
  });

  it('語彙の深刻度は error か warn のどれか', () => {
    // 表の値が増えたら（例: info）ラベルの集合も増えるので、ここで気付く
    for (const [event, spec] of Object.entries(LOG_EVENTS))
      expect(['error', 'warn'], `${event} の深刻度`).toContain(spec.level);
  });

  it('語彙の説明は空でない（行を読む人が何が起きたか分かる）', () => {
    for (const [event, spec] of Object.entries(LOG_EVENTS))
      expect(spec.message.trim().length, `${event} の説明が空`).toBeGreaterThan(0);
  });
});
