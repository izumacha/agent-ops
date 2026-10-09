// プロセス内のカウンタと、その Prometheus テキスト形式での出口。
//
// **数えた値はインスタンスごと**で、足し合わせるのはスクレイプする側（Prometheus の通常の形）。
// 耐久する事実（利用量・インシデント・監査ログ）は DB にあり `GET /usage/daily` と画面が持つので、
// ここで数えるのは**DB に残らないもの**だけにする（応答の数と、ログに出した出来事の数）。
//
// **系列の数に上限を置く（fail-safe）。** ラベルの値は閉じた語彙から採るので本来は増えないが、
// 呼び出し側が将来うっかり可変の値を渡すと、1 プロセスの Map が無制限に伸びる（メモリ枯渇）。
// 上限を超えた増加は捨てて、捨てたことを専用のカウンタで数える（黙って落とさない）。
import { HTTP_STATUS } from './api/http-status';

/** カウンタの名前と説明（`# HELP` に出る）。**ここが名前の唯一の宣言** */
export const COUNTERS = {
  // 応答の数。method と status で分ける（どちらも閉じた集合なので系列は増えない）
  agentops_http_responses_total: 'route() が返した応答の数 (method / status 別)',
  // ログに出した出来事の数。event と level で分ける（語彙は LOG_EVENTS が閉じている）
  agentops_log_events_total: 'ログに出した出来事の数 (event / level 別)',
  // 系列の上限を超えて捨てた増加の数（0 でないときはラベルの設計を間違えている）
  agentops_metrics_series_dropped_total: '系列数の上限を超えて捨てたカウントの数',
} as const;

/** カウンタの名前 */
export type CounterName = keyof typeof COUNTERS;

/**
 * 系列数の上限。
 *
 * **根拠**: いま数えている系列は (a) 応答 = メソッド 5 種 × ステータス約 15 種 = 75 以内、
 * (b) ログの出来事 = `LOG_EVENTS` の件数（40 前後）× level 2 種 = 80 以内、(c) 捨てた数 = 1。
 * 合計の 2 倍を上限にして、語彙を増やしても普通には届かない余裕を取ってある。
 */
export const MAX_METRIC_SERIES = 512;

/** ラベル（名前 → 値）。値は**閉じた語彙から採る**（可変の値を渡すと系列が増える） */
export type MetricLabels = Readonly<Record<string, string>>;

// 系列（カウンタ名＋ラベル）ごとの現在値。**プロセス内だけ**に持つ
const COUNTS = new Map<string, number>();

// プロセスが始まった時刻（ミリ秒）。再起動の検出に使うので固定値ではなく実時刻
const STARTED_AT_MS = Date.now();

/**
 * 系列のキーを組み立てる。
 * ラベルは**名前の昇順**に並べる（呼び出し側が書いた順に左右されないようにする）。
 * @param name カウンタ名
 * @param labels ラベル
 * @returns Map のキーに使う文字列
 */
function seriesKey(name: CounterName, labels: MetricLabels): string {
  // ラベルを名前順に並べて `名前=値` の列にする
  const pairs = Object.keys(labels)
    .sort()
    .map((label) => `${label}=${labels[label] ?? ''}`);
  // カウンタ名と連結する（区切りは値に現れない制御文字にして衝突を避ける）
  return [name, ...pairs].join('\u0000');
}

/**
 * カウンタを 1 つ増やす。
 *
 * **絶対に例外を投げない** — 呼び出し元は `catch` の中やログの経路なので、ここで throw すると
 * 本来の失敗が別の失敗に化ける（`describeError` が throw しないのと同じ理由）。
 * @param name カウンタ名
 * @param labels ラベル（省略時はラベル無しの 1 系列）
 */
export function incrementCounter(name: CounterName, labels: MetricLabels = {}): void {
  // 系列のキーを作る
  const key = seriesKey(name, labels);
  // 既に数えている系列なら、上限に関係なく増やせる
  const current = COUNTS.get(key);
  if (current !== undefined) {
    COUNTS.set(key, current + 1);
    return;
  }
  // 新しい系列は上限を見る。超えていたら捨てて、捨てたことを数える
  if (COUNTS.size >= MAX_METRIC_SERIES) {
    // 捨てた数そのものは既存の系列なので、この分岐へ再び入ることはない
    const dropped = COUNTS.get(seriesKey('agentops_metrics_series_dropped_total', {})) ?? 0;
    COUNTS.set(seriesKey('agentops_metrics_series_dropped_total', {}), dropped + 1);
    return;
  }
  // 上限内なら新しい系列として 1 から数え始める
  COUNTS.set(key, 1);
}

/**
 * Prometheus のラベル値の規則に合わせて逃がす（`\` `"` 改行）。
 * @param value 逃がす前の値
 * @returns 逃がした後の値
 */
function escapeLabelValue(value: string): string {
  // 逆斜線・二重引用符・改行の 3 つだけが規則で定められた対象
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Prometheus のテキスト形式（0.0.4）で現在の値を書き出す。
 *
 * **判定も集計もしない** — 出すだけで、しきい値はスクレイプする側が決める
 * （ベンチや Lighthouse と同じ「測る側は出すだけ」の分担）。
 * @param now 現在時刻（起動からの経過を出すのに使う）
 * @returns 1 行 1 系列のテキスト
 */
export function renderMetrics(now: Date): string {
  // 出力する行
  const lines: string[] = [];
  // カウンタごとに HELP / TYPE と系列を並べる（名前順で安定させる）
  for (const name of Object.keys(COUNTERS).sort() as CounterName[]) {
    // この名前の系列だけを集める
    const series = [...COUNTS.entries()].filter(([key]) => key.split('\u0000')[0] === name);
    // 1 件も無いカウンタも宣言だけは出す（スクレイプ側が「まだ 0」と「名前が無い」を区別できる）
    lines.push(`# HELP ${name} ${COUNTERS[name]}`);
    lines.push(`# TYPE ${name} counter`);
    // 系列が無ければラベル無しの 0 を出す
    if (series.length === 0) {
      lines.push(`${name} 0`);
      continue;
    }
    // 系列をキー順に並べて出す（同じ状態なら同じ出力になるようにする）
    for (const [key, value] of series.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      // キーからラベルの部分を取り出す（先頭はカウンタ名）
      const labels = key
        .split('\u0000')
        .slice(1)
        .map((pair) => {
          // `名前=値` を名前と値に割る（値に `=` が入っても最初の 1 つだけで割る）
          const at = pair.indexOf('=');
          return `${pair.slice(0, at)}="${escapeLabelValue(pair.slice(at + 1))}"`;
        });
      // ラベルが無ければ波括弧も出さない
      lines.push(
        labels.length === 0 ? `${name} ${value}` : `${name}{${labels.join(',')}} ${value}`,
      );
    }
  }
  // プロセスの起動時刻（秒）。再起動でカウンタが 0 へ戻ったことがスクレイプ側から分かる
  lines.push('# HELP agentops_process_start_time_seconds プロセスが起動した時刻 (UNIX 秒)');
  lines.push('# TYPE agentops_process_start_time_seconds gauge');
  lines.push(`agentops_process_start_time_seconds ${(STARTED_AT_MS / 1000).toFixed(3)}`);
  // 現在時刻から求めた稼働秒数。スクレイプの間隔より短い再起動を見落とさないために添える
  lines.push('# HELP agentops_process_uptime_seconds プロセスの稼働秒数');
  lines.push('# TYPE agentops_process_uptime_seconds gauge');
  lines.push(
    `agentops_process_uptime_seconds ${((now.getTime() - STARTED_AT_MS) / 1000).toFixed(3)}`,
  );
  // 末尾の改行まで含めて返す（テキスト形式は行指向）
  return `${lines.join('\n')}\n`;
}

/**
 * ラベルに使える HTTP メソッド。
 * **閉じた集合にする** — `request.method` をそのまま入れると、未知のメソッドを送るだけで
 * 系列を増やせる（Next.js は export の無いメソッドを 405 で落とすので実際には届かないが、
 * ラベルの値を外から決められる形そのものを残さない）。
 */
const KNOWN_METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);

// 閉じた集合に無い値を表すラベル値（系列が 1 本増えるだけで済ませる）
const OTHER_LABEL = 'other';

/**
 * HTTP メソッドをラベル値へ写す（知らない綴りは 1 つにまとめる）。
 * @param method 要求のメソッド
 * @returns ラベル値
 */
export function methodLabel(method: string): string {
  // 閉じた集合にあればそのまま、無ければまとめる
  return KNOWN_METHODS.has(method) ? method : OTHER_LABEL;
}

// 応答に使うステータスの集合（`HTTP_STATUS` が唯一の参照元）
const KNOWN_STATUSES = new Set(Object.values(HTTP_STATUS).map((status) => String(status)));

/**
 * ステータスをラベル値へ写す（`HTTP_STATUS` に無い番号は 1 つにまとめる）。
 * @param status 応答のステータス
 * @returns ラベル値
 */
export function statusLabel(status: number): string {
  // 文字列にしてから閉じた集合と照合する
  const text = String(status);
  return KNOWN_STATUSES.has(text) ? text : OTHER_LABEL;
}

/**
 * テスト用にカウンタを空へ戻す。
 * **本番の経路からは呼ばない**（`setReposForTesting` と同じ扱いで、テストの独立性のためだけにある）。
 */
export function resetMetricsForTesting(): void {
  // 系列をすべて消す
  COUNTS.clear();
}
