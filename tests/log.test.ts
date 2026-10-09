// ログの出口（src/lib/log.ts）の挙動を固定する。
//
// **検出網（tests/error-logging.test.ts）は「配線されているか」を構文で見るだけ**なので、
// これが無いと `formatLogLine` の中身を空にしても、カウンタを数えるのをやめても全件緑で通る
// （守備範囲を移した先が無検証だと、検出網の中心が空洞になる。このリポジトリが
// `assertApiVersionSupported` で踏んだのと同じ形）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOG_EVENTS,
  formatLogLine,
  logEvent,
  type LogEventName,
  logEventThrottled,
  resetThrottledLogsForTesting,
} from '@/lib/log';
import { renderMetrics, resetMetricsForTesting } from '@/lib/metrics';
import { describeError } from '@/lib/describe-error';
import { captureLogOutlet, loggedEvents, parseLoggedLine } from './lib/log-lines';

// console へ出た行を集める
let lines: string[] = [];

beforeEach(() => {
  // カウンタを空へ戻す（前のテストを引きずらない）
  resetMetricsForTesting();
  lines = [];
  // 間引きの記憶を空へ戻す（窓あたり 1 本の出口を使うテストが互いに影響しないように）
  resetThrottledLogsForTesting();
  // **`warn` と `error` の両方**を捕まえる — 出口のメソッドは深刻度で決まるので、
  // `error` だけを差し替えていた頃は **`warn` の出来事（`plan.unknown_plan` 等）が
  // 本物の stderr へ漏れ、`lines` からも黙って抜けていた**（実測でテストの出力に現れた）
  for (const method of ['warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(' '));
    });
  }
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

describe('整形が失敗しても投げない', () => {
  it('無効な Date を渡しても 1 行の JSON を返す（時刻は取り直す）', () => {
    // `toISOString()` が RangeError を投げる Date
    const invalid = new Date('どう見ても日付ではない');
    // 投げずに縮退した行を返す
    const line = formatLogLine('api.unexpected_error', undefined, invalid);
    // JSON として読めること
    const parsed = JSON.parse(line) as Record<string, unknown>;
    // 出来事の識別子は残る（警報の条件はここを見る）
    expect(parsed.event).toBe('api.unexpected_error');
    // 深刻度は**最も重い側へ倒す**（縮退した行を見落とさせない。語彙には触らない）
    expect(parsed.level).toBe('error');
    // 時刻はその場で取り直した有効な値（`Invalid Date` や欠落ではない）
    expect(typeof parsed.ts).toBe('string');
    expect(Number.isNaN(Date.parse(parsed.ts as string))).toBe(false);
  });

  it.each(['constructor', 'valueOf', 'toString', '__proto__'])(
    'Object.prototype のキー (%s) でも深刻度と文言が付く',
    (event) => {
      // **実測した退行**: 素の添字だと `Object.prototype` 由来の値が返るので `spec.level` は
      // `undefined` になるだけで `TypeError` にならず、**縮退の経路へ一度も届かない**。
      // 結果 `{"ts":"…","event":"constructor"}` という**深刻度も文言も無い行**が出ていた
      // （深刻度で振り分けるログ基盤はその行を捨てる）。語彙に**無い**キーだけを試していた
      // 版では拾えなかった
      const line = JSON.parse(formatLogLine(event as never)) as Record<string, unknown>;
      // 深刻度は最も重い側へ倒れる
      expect(line.level).toBe('error');
      // 文言も定型文で埋まる（空の行にしない）
      expect(typeof line.message).toBe('string');
      expect((line.message as string).length).toBeGreaterThan(0);
      // 出来事の識別子はそのまま残る
      expect(line.event).toBe(event);
    },
  );

  it('間引きは窓あたり 1 本に抑え、間引いた回も数える', () => {
    // 記憶とカウンタを空にする
    resetThrottledLogsForTesting();
    resetMetricsForTesting();
    const outlet = captureLogOutlet();
    try {
      // 同じ出来事を 3 回出す
      for (let i = 0; i < 3; i += 1) logEventThrottled('metrics.token_rejected');
      // 行は 1 本だけ
      expect(loggedEvents(outlet.calls())).toEqual(['metrics.token_rejected']);
    } finally {
      outlet.restore();
    }
    // **数えるのは毎回**（間引きが率を消さないこと）
    expect(renderMetrics(new Date())).toContain(
      'agentops_log_events_total{event="metrics.token_rejected",level="warn"} 3',
    );
  });

  it('時計が巻き戻っても間引きが居座らない（負の経過は窓を越えたとみなす）', () => {
    // 1 本出してから**時計を巻き戻す**（NTP の補正・ライブマイグレーションで実際に起きる）
    resetThrottledLogsForTesting();
    const outlet = captureLogOutlet();
    try {
      // 1 本目（この時点の時刻を覚える）
      logEventThrottled('metrics.token_rejected');
      // 1 時間巻き戻す
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 60 * 60 * 1000);
      // 2 本目。**出ること** — 経過が負のときも窓の中と扱っていた頃は、
      // 巻き戻した 1 時間ぶん行が 1 本も出なかった（しかもサーバーレスではこの行が
      // 唯一の読める信号なので、原因を調べたいまさにその時間が沈黙する）
      logEventThrottled('metrics.token_rejected');
      expect(loggedEvents(outlet.calls())).toHaveLength(2);
    } finally {
      outlet.restore();
    }
  });

  it('間引きの記憶を忘れると次の 1 本が出る', () => {
    const outlet = captureLogOutlet();
    try {
      // 1 本出してから記憶を忘れ、もう 1 本出す
      resetThrottledLogsForTesting();
      logEventThrottled('metrics.token_rejected');
      resetThrottledLogsForTesting();
      logEventThrottled('metrics.token_rejected');
      // 2 本出る（窓の判定が「常に出さない」へ退行していないこと）
      expect(loggedEvents(outlet.calls())).toHaveLength(2);
    } finally {
      outlet.restore();
    }
  });

  it('resetThrottledLogsForTesting は本番では呼べない（間引きを外させない）', () => {
    // 本番のふりをする
    vi.stubEnv('NODE_ENV', 'production');
    try {
      // 呼ぶと投げる（`resetMetricsForTesting` と同じ扱い。この 1 本が無いと
      // ガードの 3 行を消しても全件緑で通る＝姉妹の検査で実測済みの非対称）
      expect(() => resetThrottledLogsForTesting()).toThrow(/本番/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('`console` のメソッドは深刻度で選ぶ（語彙の level から導いて両方向を見る）', () => {
    // **語彙から代表を 1 つずつ採る** — 綴りを決め打つと、その出来事の `level` を変えた
    // 瞬間にこの検査が片側しか見なくなる（正本は `LOG_EVENTS`）
    const names = Object.keys(LOG_EVENTS) as LogEventName[];
    const warnEvent = names.find((name) => LOG_EVENTS[name].level === 'warn');
    const errorEvent = names.find((name) => LOG_EVENTS[name].level === 'error');
    // 両方の深刻度が語彙に実在すること（片方しか無いと検査が半分になる＝fail-closed）
    expect(warnEvent, '語彙に warn の出来事が無い').toBeDefined();
    expect(errorEvent, '語彙に error の出来事が無い').toBeDefined();
    // 2 つのメソッドを別々に捕まえる
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // warn の出来事は `console.warn` だけに出る
      logEvent(warnEvent as LogEventName);
      expect(loggedEvents(warnSpy.mock.calls)).toEqual([warnEvent]);
      expect(errorSpy.mock.calls).toHaveLength(0);
      // error の出来事は `console.error` だけに出る
      logEvent(errorEvent as LogEventName);
      expect(loggedEvents(errorSpy.mock.calls)).toEqual([errorEvent]);
      expect(warnSpy.mock.calls).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('Object.prototype のキーでも、ログとメトリクスの深刻度がそろう', () => {
    // ログを端末へ出さない
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // 語彙に無い「継承しているだけ」のキーで出す
      logEvent('valueOf' as never);
      // ログ側の深刻度
      expect(parseLoggedLine(spy.mock.calls[0]).level).toBe('error');
    } finally {
      spy.mockRestore();
    }
    // **メトリクス側のラベルも見る。** ログ行だけを見ていた版は、数える側の縮退だけを
    // `'warn'` へ差し替える変異が全件緑のまま通った（実測）— ログは `level="error"` を
    // 出すのにカウンタは `level="warn"` で数え、`level="error"` で警報を組んだ運用者には
    // 縮退した行が 1 件も見えない。ADR-0014 が「同じモジュール実体の中では食い違わない」と
    // 名乗っているのはまさにこの一致なので、両辺を同じテストで固定する
    expect(renderMetrics(new Date())).toContain(
      'agentops_log_events_total{event="valueOf",level="error"} 1',
    );
  });

  it('logEvent も語彙に無いキーで投げない（固めた縮退へ実際に届く）', () => {
    // ログを端末へ出さない
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // **`logEvent` が先に落ちると `formatLogLine` の縮退へ一度も届かない。**
      // 以前はここで `LOG_EVENTS[event].level` を直接読んでいたので TypeError になり、
      // 固めたのは到達しない側だった（実測）。この関数は `catch` の中からも、
      // `pg` のプール障害ハンドラ（要求の外）からも呼ばれる
      expect(() => logEvent('typo.not_in_vocabulary' as never)).not.toThrow();
      // 1 行は出ていること（握り潰しではない）
      expect(spy).toHaveBeenCalledTimes(1);
      // 出来事の識別子は残る
      expect(parseLoggedLine(spy.mock.calls[0]).event).toBe('typo.not_in_vocabulary');
    } finally {
      spy.mockRestore();
    }
  });

  it('語彙に無いキーを渡しても投げない（型の外からの呼び出しへの保険）', () => {
    // **型は拒むが、型の外（JS からの呼び出し・`as never`）では起こりうる**。
    // 以前は語彙の引きが `try` の外にあり、縮退側も同じ値を読み直していたので投げていた
    const line = formatLogLine('typo.not_in_vocabulary' as never);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    // 何が起きたかは識別子で残る（握り潰しではない）
    expect(parsed.event).toBe('typo.not_in_vocabulary');
    expect(parsed.level).toBe('error');
    expect(typeof parsed.message).toBe('string');
  });

  it('JSON にできない診断は落として最小の行を返す', () => {
    // 循環参照を持つ診断（`JSON.stringify` が throw する）
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    // 投げずに診断なしの行を返す
    const parsed = JSON.parse(formatLogLine('api.unexpected_error', circular)) as Record<
      string,
      unknown
    >;
    // 診断は落ちているが、出来事は残る
    expect(parsed.error).toBeUndefined();
    expect(parsed.event).toBe('api.unexpected_error');
  });
});
