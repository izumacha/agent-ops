// プロセス内カウンタと Prometheus テキスト形式の出口（src/lib/metrics.ts）の挙動を固定する。
//
// **ここが無いと、出口が壊れても誰も気付かない** — 本番の経路では「数えた値が正しいか」を
// 誰も照合しないので（スクレイプ側が読むだけ）、整形を潰しても API テストは緑のまま通る。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COUNTERS,
  GAUGES,
  KNOWN_METHODS,
  MAX_METRIC_SERIES,
  OTHER_LABEL,
  countHttpResponse,
  incrementCounter,
  methodLabel,
  renderMetrics,
  resetMetricsForTesting,
  statusLabel,
} from '@/lib/metrics';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { LOG_EVENTS } from '@/lib/log';
// Next.js が Route Handler として呼ぶ export 名（閉じた集合の網羅を照合する独立な手掛かり）
import { HTTP_METHOD_EXPORTS } from './lib/route-files';

// 1 本ずつ独立に見る（カウンタはモジュールの状態なので前のテストを引きずる）
beforeEach(() => {
  resetMetricsForTesting();
});

// 環境変数の差し替えを毎回戻す（本番のふりをしたまま次のテストへ漏らさない）
afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * 出力から 1 系列の値を読む。
 * @param text `renderMetrics` の出力
 * @param series `名前{ラベル}` の綴り（ラベル無しなら名前だけ）
 * @returns 値（その系列が無ければ null）
 */
function valueOf(text: string, series: string): number | null {
  // 行の先頭が一致する行を探す（`# HELP` などの注釈行は先頭が `#` なので当たらない）
  const line = text.split('\n').find((row) => row.startsWith(`${series} `));
  // 無ければ null、あれば末尾の数値
  return line === undefined ? null : Number(line.slice(series.length + 1));
}

describe('メトリクスのカウンタ', () => {
  it('同じ系列は足され、ラベルが違えば別の系列になる', () => {
    // 同じラベルで 2 回数える
    incrementCounter('agentops_http_responses_total', { method: 'GET', status: '200' });
    incrementCounter('agentops_http_responses_total', { method: 'GET', status: '200' });
    // ラベルを変えて 1 回数える
    incrementCounter('agentops_http_responses_total', { method: 'POST', status: '201' });
    // 書き出した結果を読む
    const text = renderMetrics(new Date());
    expect(valueOf(text, 'agentops_http_responses_total{method="GET",status="200"}')).toBe(2);
    expect(valueOf(text, 'agentops_http_responses_total{method="POST",status="201"}')).toBe(1);
  });

  it('ラベルは名前順に並ぶ（呼び出し側が書いた順に左右されない）', () => {
    // わざと逆順で渡す
    incrementCounter('agentops_log_events_total', { level: 'error', event: 'plan.unknown_plan' });
    // 出力は名前順（event → level）
    expect(renderMetrics(new Date())).toContain(
      'agentops_log_events_total{event="plan.unknown_plan",level="error"} 1',
    );
  });

  it('1 件も無いカウンタも宣言と 0 を出す（「まだ 0」と「名前が無い」を区別できる）', () => {
    // 何も数えずに書き出す
    const text = renderMetrics(new Date());
    // 宣言したカウンタはすべて現れる
    for (const name of Object.keys(COUNTERS)) {
      expect(text).toContain(`# HELP ${name} `);
      expect(text).toContain(`# TYPE ${name} counter`);
      expect(valueOf(text, name)).toBe(0);
    }
  });

  it('系列が上限に達したら新しい系列を捨て、捨てた数を数える', () => {
    // **上限が無いと、ラベルに可変の値を渡す退行だけで 1 プロセスのメモリが無制限に伸びる**。
    // 上限ちょうどまで埋めてから 1 本足して、捨てたことが観測できることまで見る
    for (let i = 0; i < MAX_METRIC_SERIES; i += 1)
      incrementCounter('agentops_log_events_total', { event: `e${i}`, level: 'error' });
    // ここで 1 本増やすと上限を超える
    incrementCounter('agentops_log_events_total', { event: 'overflow', level: 'error' });
    const text = renderMetrics(new Date());
    // 捨てた系列は出力に現れない
    expect(valueOf(text, 'agentops_log_events_total{event="overflow",level="error"}')).toBeNull();
    // 捨てた数が 1 件として観測できる（黙って落とさない）
    expect(valueOf(text, 'agentops_metrics_series_dropped_total')).toBe(1);
  });

  it('上限に達しても既にある系列は増やせる', () => {
    // 上限ちょうどまで埋める
    for (let i = 0; i < MAX_METRIC_SERIES; i += 1)
      incrementCounter('agentops_log_events_total', { event: `e${i}`, level: 'error' });
    // 既存の系列をもう 1 回数える（捨ててはいけない — 上限は「新しい系列」に対するもの）
    incrementCounter('agentops_log_events_total', { event: 'e0', level: 'error' });
    const text = renderMetrics(new Date());
    expect(valueOf(text, 'agentops_log_events_total{event="e0",level="error"}')).toBe(2);
    // 捨てていないので捨てた数は 0
    expect(valueOf(text, 'agentops_metrics_series_dropped_total')).toBe(0);
  });

  it('ラベル値の逆斜線・二重引用符・改行を逃がす', () => {
    // 規則で定められた 3 つの文字を含む値を渡す（閉じた語彙から外れた値が来ても壊れない）
    incrementCounter('agentops_log_events_total', { event: 'a\\b"c\nd', level: 'error' });
    // 逃がした形で現れる（解析器が行や引用の境目を取り違えない）
    expect(renderMetrics(new Date())).toContain(
      'agentops_log_events_total{event="a\\\\b\\"c\\nd",level="error"} 1',
    );
  });

  it('宣言したゲージはすべて宣言と値を出す（名前は GAUGES から導く）', () => {
    // 現在時刻を渡して書き出す
    const text = renderMetrics(new Date());
    // **名前をここへ書き写さない** — 本体へ直書きしていた頃は、名前を書き換えても
    // どの検査も落ちなかった（表に移したので導出で照合できる）
    expect(Object.keys(GAUGES).length).toBeGreaterThan(0);
    for (const name of Object.keys(GAUGES)) {
      // 宣言（HELP / TYPE）と値の 3 行が出ていること
      expect(text).toContain(`# HELP ${name} `);
      expect(text).toContain(`# TYPE ${name} gauge`);
      expect(valueOf(text, name)).not.toBeNull();
    }
    // 起動時刻は正の UNIX 秒、稼働秒数は 0 以上（意味のある値であること）
    expect(valueOf(text, 'agentops_process_start_time_seconds')).toBeGreaterThan(0);
    expect(valueOf(text, 'agentops_process_uptime_seconds')).toBeGreaterThanOrEqual(0);
  });

  it('稼働秒数は渡した時刻から求める（引数を無視していれば増えない）', () => {
    // 起動時刻を読む
    const start = valueOf(renderMetrics(new Date()), 'agentops_process_start_time_seconds');
    expect(start).not.toBeNull();
    // 起動から 1 時間後の時刻で書き出す
    const later = new Date((start! + 3_600) * 1_000);
    // 稼働秒数が約 1 時間になる（固定値を返していれば落ちる）
    expect(valueOf(renderMetrics(later), 'agentops_process_uptime_seconds')).toBeCloseTo(3_600, 1);
  });

  it('ゲージはカウンタと混ざらない（型の宣言が counter にならない）', () => {
    // 同じ名前が counter として宣言されていないこと
    const text = renderMetrics(new Date());
    for (const name of Object.keys(GAUGES)) expect(text).not.toContain(`# TYPE ${name} counter`);
  });

  it('末尾は改行で終わる（行指向の形式なので最後の行も区切る）', () => {
    expect(renderMetrics(new Date()).endsWith('\n')).toBe(true);
  });
});

describe('ラベル値の閉じ込め', () => {
  // **一覧をここへ書き写さない**（閉じた集合の正本は `KNOWN_METHODS`）
  it.each([...KNOWN_METHODS])('%s はそのままラベルになる', (method) => {
    expect(methodLabel(method)).toBe(method);
  });

  // **閉じた集合は「Next.js が届けうるメソッド」を全部含むこと。**
  //
  // 手掛かりを `KNOWN_METHODS` 自身から取ると、集合から外した分は上の `it.each` のケースからも
  // 消えるので**外す変異が素通りする**（実測で `HEAD` / `OPTIONS` を外しても全件緑だった。
  // この repo が繰り返し記録している「同じ判定でガードを書くと一緒に狭まる」形）。
  // そこで**別の宣言**（`tests/lib/route-files.ts` の `HTTP_METHOD_EXPORTS`。Next.js が
  // Route Handler として呼ぶ export 名を、ルートの結線を見る検査のために持っている）と
  // 突き合わせる。Next.js は `HEAD` を `GET` のハンドラで応え、`OPTIONS` は自分で実装するので、
  // 外すと死活監視の `HEAD` が「未知・敵対的なメソッド」のまとめ先に積まれる
  it.each([...HTTP_METHOD_EXPORTS])('Next.js が届けうる %s は閉じた集合に入っている', (method) => {
    expect(methodLabel(method)).toBe(method);
  });

  it.each(['TRACE', 'CONNECT', 'PROPFIND', '', 'GET ', 'get'])(
    '閉じた集合に無いメソッド (%s) は 1 つにまとめる',
    (method) => {
      // **系列を外から増やせる形を残さない**（まとめ先は 1 本だけ）
      expect(methodLabel(method)).toBe(OTHER_LABEL);
    },
  );

  it('HTTP_STATUS にある番号はそのままラベルになる', () => {
    // 唯一の参照元から導く（番号の一覧をここへ書き写さない）
    for (const status of Object.values(HTTP_STATUS))
      expect(statusLabel(status)).toBe(String(status));
  });

  it.each([418, 999, 0, -1])('HTTP_STATUS に無い番号 (%i) は 1 つにまとめる', (status) => {
    expect(statusLabel(status)).toBe('other');
  });
});

describe('応答を数える入口', () => {
  it('メソッドとステータスを閉じた集合へ写してから数える', () => {
    // 既知のメソッド・既知のステータス
    countHttpResponse('POST', HTTP_STATUS.CREATED);
    // 未知のメソッド・未知のステータス（どちらもまとめ先へ入る）
    countHttpResponse('TRACE', 418);
    // 書き出して確かめる
    const text = renderMetrics(new Date());
    expect(
      valueOf(text, `agentops_http_responses_total{method="POST",status="${HTTP_STATUS.CREATED}"}`),
    ).toBe(1);
    expect(
      valueOf(
        text,
        `agentops_http_responses_total{method="${OTHER_LABEL}",status="${OTHER_LABEL}"}`,
      ),
    ).toBe(1);
  });

  it('同じ組み合わせは足される', () => {
    // 3 回数える
    for (let i = 0; i < 3; i += 1) countHttpResponse('GET', HTTP_STATUS.OK);
    // 1 系列に 3 が乗る
    expect(
      valueOf(
        renderMetrics(new Date()),
        `agentops_http_responses_total{method="GET",status="${HTTP_STATUS.OK}"}`,
      ),
    ).toBe(3);
  });
});

describe('系列数の上限', () => {
  // **上限の根拠を正本から導く**（metrics.ts の docstring に算術を書き写すと、語彙を増やした
  // ときにそこだけが古くなる。以前は「メソッド 5 種 × ステータス約 15 種 = 75」と書いてあり、
  // まとめ先の `other` を数えておらず実際の上界と合っていなかった）
  it('いま数えうる系列の上界より十分に大きい', () => {
    // (a) 応答 = メソッドの値（既知 + まとめ先）× ステータスの値（既知 + まとめ先）
    const methods = KNOWN_METHODS.length + 1;
    const statuses = new Set(Object.values(HTTP_STATUS)).size + 1;
    // (b) ログの出来事 = 語彙の件数（level は event から定まるので倍にならない）
    const logEvents = Object.keys(LOG_EVENTS).length;
    // 捨てた数は `COUNTS` の外（上限の外）に持つので数えない
    const upperBound = methods * statuses + logEvents;
    // 上限は上界を超えていること（超えていないと正常な運用で系列を捨て始める）
    expect(MAX_METRIC_SERIES).toBeGreaterThan(upperBound);
    // **余裕も要求する** — 語彙を少し増やしただけで捨て始める値だと、上限の意味が
    // 「設計の誤りを知らせる」から「普通に効く制限」へ変わる
    expect(MAX_METRIC_SERIES).toBeGreaterThanOrEqual(upperBound * 3);
  });
});

describe('テスト専用の初期化', () => {
  it('本番では呼べない（運用の数字が黙って 0 へ戻るのを防ぐ）', () => {
    // 本番のふりをする（vitest が後始末まで面倒を見る）
    vi.stubEnv('NODE_ENV', 'production');
    // 呼ぶと投げる（`setReposForTesting` と同じ扱い）
    expect(() => resetMetricsForTesting()).toThrow(/本番/);
  });

  it('本番以外では空へ戻す', () => {
    // 1 件数えてから
    countHttpResponse('GET', HTTP_STATUS.OK);
    // 戻すと系列が消える（`renderMetrics` はラベル無しの 0 だけを出す）
    resetMetricsForTesting();
    expect(valueOf(renderMetrics(new Date()), 'agentops_http_responses_total')).toBe(0);
  });
});
