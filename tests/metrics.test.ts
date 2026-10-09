// プロセス内カウンタと Prometheus テキスト形式の出口（src/lib/metrics.ts）の挙動を固定する。
//
// **ここが無いと、出口が壊れても誰も気付かない** — 本番の経路では「数えた値が正しいか」を
// 誰も照合しないので（スクレイプ側が読むだけ）、整形を潰しても API テストは緑のまま通る。
import { beforeEach, describe, expect, it } from 'vitest';
import {
  COUNTERS,
  MAX_METRIC_SERIES,
  incrementCounter,
  methodLabel,
  renderMetrics,
  resetMetricsForTesting,
  statusLabel,
} from '@/lib/metrics';
import { HTTP_STATUS } from '@/lib/api/http-status';

// 1 本ずつ独立に見る（カウンタはモジュールの状態なので前のテストを引きずる）
beforeEach(() => {
  resetMetricsForTesting();
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

  it('起動時刻と稼働秒数を出す（再起動でカウンタが 0 へ戻ったことが分かる）', () => {
    // 現在時刻を渡して書き出す
    const text = renderMetrics(new Date());
    // 2 つの gauge が宣言と値を持つ
    expect(text).toContain('# TYPE agentops_process_start_time_seconds gauge');
    expect(text).toContain('# TYPE agentops_process_uptime_seconds gauge');
    expect(valueOf(text, 'agentops_process_start_time_seconds')).toBeGreaterThan(0);
    expect(valueOf(text, 'agentops_process_uptime_seconds')).toBeGreaterThanOrEqual(0);
  });

  it('末尾は改行で終わる（行指向の形式なので最後の行も区切る）', () => {
    expect(renderMetrics(new Date()).endsWith('\n')).toBe(true);
  });
});

describe('ラベル値の閉じ込め', () => {
  it.each(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'])('%s はそのままラベルになる', (method) => {
    expect(methodLabel(method)).toBe(method);
  });

  it.each(['TRACE', 'OPTIONS', 'HEAD', '', 'GET ', 'get'])(
    '閉じた集合に無いメソッド (%s) は 1 つにまとめる',
    (method) => {
      // **系列を外から増やせる形を残さない**（まとめ先は 1 本だけ）
      expect(methodLabel(method)).toBe('other');
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
