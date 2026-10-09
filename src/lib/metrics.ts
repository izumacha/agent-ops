// プロセス内のカウンタと、その Prometheus テキスト形式での出口。
//
// **数えた値はインスタンスごと**で、足し合わせるのはスクレイプする側（Prometheus の通常の形）。
// 耐久する事実（利用量・インシデント・監査ログ）は DB にあり `GET /usage/daily` と画面が持つので、
// ここで数えるのは**DB に残らないもの**だけにする（応答の数と、ログに出した出来事の数）。
//
// **系列の数に上限を置く（fail-safe）。** ラベルの値は閉じた語彙から採るので本来は増えないが、
// 呼び出し側が将来うっかり可変の値を渡すと、1 プロセスの Map が無制限に伸びる（メモリ枯渇）。
// 上限を超えた増加は捨てて、捨てたことを専用のカウンタで数える（黙って落とさない）。
//
// **このファイルは `src/lib/log.ts` を import しない。** あちらがこちらを呼ぶので、
// 逆向きの依存を足すと循環する（系列の上限の根拠に出てくる `LOG_EVENTS` の件数も、
// だからここでは数えずテスト側で突き合わせる）。
import { HTTP_STATUS } from './api/http-status';

/** カウンタの名前と説明（`# HELP` に出る）。**カウンタの名前はここが唯一の宣言** */
export const COUNTERS = {
  // 応答の数。method と status で分ける（どちらも閉じた集合なので系列は増えない）
  agentops_http_responses_total: 'HTTP で返した応答の数 (method / status 別)',
  // ログに出した出来事の数。event と level で分ける（語彙は LOG_EVENTS が閉じている）
  agentops_log_events_total: 'ログに出した出来事の数 (event / level 別)',
  // 系列の上限を超えて捨てた増加の数（0 でないときはラベルの設計を間違えている）
  agentops_metrics_series_dropped_total: '系列数の上限を超えて捨てたカウントの数',
} as const;

/** カウンタの名前 */
export type CounterName = keyof typeof COUNTERS;

/** ゲージ 1 本の宣言（カウンタと違って積み上げず、読んだ瞬間の値を出す） */
interface GaugeSpec {
  // `# HELP` に出る説明
  readonly help: string;
  // 出す値（`renderMetrics` に渡された時刻から求める）
  readonly value: (now: Date) => number;
}

/**
 * ゲージの名前と値の作り方。**ゲージの名前もここが唯一の宣言**。
 *
 * **カウンタと同じ表の形にしてある理由。** 以前は `renderMetrics` の中に名前を直書きしていたので、
 * 「名前の宣言は `COUNTERS` だけ」という約束が実際には守られておらず、`Object.keys(COUNTERS)` から
 * 導いていた API テストの照合がこの 2 本だけ素通りしていた（名前を書き換えても全件緑）。
 */
export const GAUGES = {
  // プロセスの起動時刻（秒）。再起動でカウンタが 0 へ戻ったことがスクレイプ側から分かる
  agentops_process_start_time_seconds: {
    help: 'プロセスが起動した時刻 (UNIX 秒)',
    value: () => STARTED_AT_MS / MILLIS_PER_SECOND,
  },
  // 現在時刻から求めた稼働秒数。スクレイプの間隔より短い再起動を見落とさないために添える
  agentops_process_uptime_seconds: {
    help: 'プロセスの稼働秒数',
    value: (now: Date) => (now.getTime() - STARTED_AT_MS) / MILLIS_PER_SECOND,
  },
} as const satisfies Record<string, GaugeSpec>;

/** ゲージの名前 */
export type GaugeName = keyof typeof GAUGES;

/**
 * 系列数の上限。
 *
 * **根拠**（いま数えている系列の見積もり。数えられる上限そのものは
 * `tests/metrics.test.ts` が 3 つの正本から導いて照合するので、ここに算術を書き写さない）:
 * (a) 応答 = `methodLabel` が返しうる値 × `statusLabel` が返しうる値（どちらも閉じた集合）、
 * (b) ログの出来事 = `LOG_EVENTS` の件数（`level` は `event` から定まるので倍にはならない）。
 * 捨てた数（`DROPPED_COUNTER`）はこの上限の外に持つので数えない。
 * 上限はその合計に 3 倍以上の余裕を持たせた値で、語彙を増やしても普通には届かない。
 */
export const MAX_METRIC_SERIES = 1_024;

/** ラベル（名前 → 値）。値は**閉じた語彙から採る**（可変の値を渡すと系列が増える） */
export type MetricLabels = Readonly<Record<string, string>>;

// 系列（カウンタ名＋ラベル）ごとの現在値。**プロセス内だけ**に持つ
const COUNTS = new Map<string, number>();

/**
 * 値を `COUNTS` ではなく専用の変数が持つカウンタ（ラベルを持たない 1 系列だけ）。
 *
 * **上限の外に置く理由**: 上限に達してから**最初に**捨てるとき、`COUNTS` の中へこの系列を
 * 作ると `COUNTS.size` が上限を 1 本超える（上限そのものが破れる）。以前はそうなっており、
 * しかも分岐のコメントは「捨てた数そのものは既存の系列なので、この分岐へ再び入ることはない」と
 * 書いていた — それが真になるのは 2 件目以降だけだった。
 */
const DROPPED_COUNTER: CounterName = 'agentops_metrics_series_dropped_total';

// 系列数の上限を超えて捨てた増加の数（`COUNTS` の外。理由は上）
let droppedSeries = 0;

// 1 秒のミリ秒数（ゲージを秒で出すのに使う）
const MILLIS_PER_SECOND = 1_000;

/**
 * プロセスが始まった時刻（ミリ秒）。
 *
 * **`Date.now()` そのままにしない。** このモジュールが評価されるのは「最初の要求が
 * これを取り込むルートへ届いたとき」なので、`Date.now()` を書くと**プロセスの起動から
 * 最初の要求までの遅れだけ後ろへずれる**（実測: プロセスは 35 秒生きているのに
 * `agentops_process_uptime_seconds` が 29.774 を返した）。サーバーレスではその遅れが
 * コールドスタート 1 回分になる。`process_start_time_seconds` は Prometheus の慣習で
 * 「プロセスの起動時刻」を意味する名前なので、名前のとおりの値を出す。
 */
const STARTED_AT_MS = Date.now() - process.uptime() * MILLIS_PER_SECOND;

// 系列のキーの区切り（ラベルの値に現れない制御文字にして衝突を避ける）
const KEY_SEPARATOR = '\u0000';

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
  // カウンタ名と連結する
  return [name, ...pairs].join(KEY_SEPARATOR);
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
  // 捨てた数は専用の変数が持つ（`COUNTS` の外。ラベルは取らない）
  if (name === DROPPED_COUNTER) {
    droppedSeries += 1;
    return;
  }
  // 系列のキーを作る
  const key = seriesKey(name, labels);
  // 既に数えている系列なら、上限に関係なく増やせる
  const current = COUNTS.get(key);
  if (current !== undefined) {
    COUNTS.set(key, current + 1);
    return;
  }
  // 新しい系列は上限を見る。超えていたら捨てて、捨てたことを数える
  // （数える先は `COUNTS` の外なので、ここで上限を 1 本超えることはない）
  if (COUNTS.size >= MAX_METRIC_SERIES) {
    droppedSeries += 1;
    return;
  }
  // 上限内なら新しい系列として 1 から数え始める
  COUNTS.set(key, 1);
}

/**
 * `agentops_http_responses_total` が**数えない**応答の種類（既知の非可視）。
 *
 * 数えるのは `src/app/**` の `route.ts` が export する関数の応答だけで、そこは
 * `withResponseCount` を通ること（`tests/route-wrapping.test.ts` が印から全数を要求）で
 * 漏れが出ない。**それ以外に応答を返す経路が 3 種類ある。**
 *
 * 以前は入口の 404 だけを「数えられない経路が 1 つある」と書いており、画面の描画と
 * Server Action が**1 件も数えられていないのに言及されていなかった** — 運用者が
 * 「他の HTTP 通信はすべてこの系列に乗る」と読め、ダッシュボードのログイン総当たりや
 * 描画中の 500 を警報の条件に書いても一度も発火しない（`src/app` 配下に `page.tsx` が
 * 6 枚と `'use server'` のモジュールが 3 本ある）。
 *
 * **鍵はそのまま文書の目印。** `docs/deploy.md` と `docs/adr/0014-observability.md` が
 * `<!--uncounted:<鍵>-->` を持つことを `tests/docs-gate.test.ts` がこの表から導いて要求する
 * （散文だけに置くと、種類が増えたとき文書の側だけが古くなる。この穴がまさにそれだった）。
 * 種類が増えていないことは `tests/route-wrapping.test.ts` が `src/app` 配下の分類から確かめる。
 */
export const UNCOUNTED_RESPONSE_SOURCES = {
  // 入口（`src/proxy.ts`）が percent-decode できないパスへ返す 404。**数えようとしても
  // 見えない** — 入口は Route Handler とは別のモジュール実体で評価されるため（本番ビルドで
  // 実測: health の 200 は `/metrics` に現れるのに、入口の 404 は 2 件とも現れなかった）。
  // 数えたように見えて見えない形は作らず、ログだけで非可視を解いてある
  // （`entry.undecodable_path`。1 プロセスに 1 度だけ。**その行の数も同じ理由で
  // `agentops_log_events_total` には現れない**）
  entryProxy: '入口 (src/proxy.ts) の短絡（別モジュール実体なので数えようとしても見えない）',
  // 画面の描画（`src/app` 配下の `.tsx`）。Next.js は描画の応答を Route Handler として
  // 扱わないので、包む場所がそもそも無い（`error.tsx` の 500 も同じ）
  pageRender: '画面の描画 (src/app 配下の .tsx)。包める入口が無い',
  // Server Action（`'use server'` のモジュール）。POST で届くが Route Handler ではないので
  // 同じく包めない。**ログイン失敗はログに出す**（`session.login_rejected` /
  // `session.cross_origin_action`）ので、総当たりは警報の条件に書ける＝ただし条件は
  // ログ側の `event` で、この系列ではない
  serverAction: "Server Action ('use server' のモジュール)。包める入口が無い",
} as const;

/** 数えない応答の種類の名前（上の表の鍵） */
export type UncountedResponseSource = keyof typeof UNCOUNTED_RESPONSE_SOURCES;

/**
 * 応答 1 件を数える。
 *
 * **応答を数える唯一の入口**。`route()` が包む経路だけでなく、包まない経路
 * （`GET /health`・受信 Webhook・画面側の CSV・`GET /metrics` 自身）もここを通す。
 * 以前は `route()` の中でだけ数えていたので、**未認証で誰でも叩ける受信 Webhook の
 * 401 の山がメトリクスにもログにも 1 件も現れなかった**（署名鍵の設定ミスが無言になる）。
 * 「どの Route Handler もこのラッパーを通っていること」は `tests/route-wrapping.test.ts` が
 * 印から導いて要求する。
 *
 * **数えないものは `UNCOUNTED_RESPONSE_SOURCES` が正本**（入口の短絡・画面の描画・
 * Server Action の 3 種類）。この系列だけを見て「アプリの HTTP 通信はすべて覆われている」と
 * 読まないこと。
 * @param method 要求のメソッド（閉じた集合へ写してからラベルにする）
 * @param status 応答のステータス（同じく閉じた集合へ写す）
 */
export function countHttpResponse(method: string, status: number): void {
  // ラベルは 2 つだけ。どちらも閉じた集合なので系列は増えない
  incrementCounter('agentops_http_responses_total', {
    method: methodLabel(method),
    status: statusLabel(status),
  });
}

/**
 * Prometheus のラベル値の規則に合わせて逃がす（`\` `"` 改行）。
 *
 * **復帰（CR）も逃がす。** 規則が挙げているのは逆斜線・二重引用符・LF の 3 つだけだが、
 * 生の CR が引用符の中に残ると**その 1 行が壊れる**（CRLF で行を割る収集側は値の途中で
 * 切るか行ごと捨てる＝その系列が黙って落ちる）。いまラベルへ渡しているのはどれも閉じた
 * 語彙の値なので実際には現れないが、逃がす目的は「将来うっかり可変の値を渡しても出力が
 * 壊れない」ことなので、行を割りうる 2 文字を同じようには扱う。
 * @param value 逃がす前の値
 * @returns 逃がした後の値
 */
function escapeLabelValue(value: string): string {
  // 逆斜線・二重引用符・改行（LF / CR）を逃がす
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/**
 * 系列のキーをカウンタ名で束ねる（走査は 1 度だけ）。
 *
 * **カウンタ名ごとに `COUNTS` を読み直さない** — 以前は名前ごとに全系列を `filter` して
 * さらにキーを `split` していたので、走査がカウンタの本数だけ重なっていた。
 * @returns カウンタ名 → その名前の系列（キーと値）の一覧
 */
function groupSeriesByName(): Map<string, { key: string; labels: string[]; value: number }[]> {
  // 束ねた結果
  const grouped = new Map<string, { key: string; labels: string[]; value: number }[]>();
  // 系列を 1 度だけ走査する
  for (const [key, value] of COUNTS) {
    // 区切りの位置（ラベルが無い系列はキーがカウンタ名そのもの）
    const at = key.indexOf(KEY_SEPARATOR);
    // カウンタ名と `名前=値` の列に割る
    const name = at === -1 ? key : key.slice(0, at);
    const labels = at === -1 ? [] : key.slice(at + 1).split(KEY_SEPARATOR);
    // その名前の一覧へ足す
    const bucket = grouped.get(name);
    if (bucket === undefined) grouped.set(name, [{ key, labels, value }]);
    else bucket.push({ key, labels, value });
  }
  // 束ねた結果を返す
  return grouped;
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
  // 系列を 1 度だけ走査してカウンタ名で束ねる
  const grouped = groupSeriesByName();
  // カウンタごとに HELP / TYPE と系列を並べる（名前順で安定させる）
  for (const name of Object.keys(COUNTERS).sort() as CounterName[]) {
    // 1 件も無いカウンタも宣言だけは出す（スクレイプ側が「まだ 0」と「名前が無い」を区別できる）
    lines.push(`# HELP ${name} ${COUNTERS[name]}`);
    lines.push(`# TYPE ${name} counter`);
    // 捨てた数だけは `COUNTS` の外（上限の外）に持つので、ここは変数から出す
    if (name === DROPPED_COUNTER) {
      lines.push(`${name} ${droppedSeries}`);
      continue;
    }
    // この名前の系列
    const series = grouped.get(name) ?? [];
    // 系列が無ければラベル無しの 0 を出す
    if (series.length === 0) {
      lines.push(`${name} 0`);
      continue;
    }
    // 系列をキー順に並べて出す（同じ状態なら同じ出力になるようにする）
    for (const { labels, value } of series.sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    )) {
      // `名前=値` を Prometheus の `名前="値"` へ直す（値に `=` が入っても最初の 1 つだけで割る）
      const rendered = labels.map((pair) => {
        const at = pair.indexOf('=');
        return `${pair.slice(0, at)}="${escapeLabelValue(pair.slice(at + 1))}"`;
      });
      // ラベルが無ければ波括弧も出さない
      lines.push(
        rendered.length === 0 ? `${name} ${value}` : `${name}{${rendered.join(',')}} ${value}`,
      );
    }
  }
  // ゲージも同じ表から出す（名前を直書きしない）
  for (const name of Object.keys(GAUGES).sort() as GaugeName[]) {
    // 宣言と値を並べる（小数 3 桁まで。ミリ秒の分解能をそのまま表す）
    lines.push(`# HELP ${name} ${GAUGES[name].help}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name} ${GAUGES[name].value(now).toFixed(3)}`);
  }
  // 末尾の改行まで含めて返す（テキスト形式は行指向）
  return `${lines.join('\n')}\n`;
}

/**
 * ラベルに使える HTTP メソッド。
 *
 * **閉じた集合にする** — `request.method` をそのまま入れると、未知のメソッドを送るだけで
 * 系列を増やせる（ラベルの値を外から決められる形そのものを残さない）。
 *
 * **`HEAD` と `OPTIONS` も入れる。** Next.js の App Router は `HEAD` を **`GET` の
 * ハンドラを呼んで**応えるし、`OPTIONS` は自分で実装する（どちらも export は要らない）。
 * つまり「export の無いメソッドは 405 で届かない」は成り立たず、外していた版では
 * 死活監視の `HEAD` が**未知・敵対的なメソッド用のまとめ先 `other`** に積まれていた
 * （警報に使える信号ではなくなる）。
 */
export const KNOWN_METHODS = ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'] as const;

// 閉じた集合に無い値を表すラベル値（系列が 1 本増えるだけで済ませる）
export const OTHER_LABEL = 'other';

// 照合用の集合（配列は系列数の見積もりをテストから導くために公開している）
const KNOWN_METHOD_SET: ReadonlySet<string> = new Set(KNOWN_METHODS);

/**
 * HTTP メソッドをラベル値へ写す（知らない綴りは 1 つにまとめる）。
 * @param method 要求のメソッド
 * @returns ラベル値
 */
export function methodLabel(method: string): string {
  // 閉じた集合にあればそのまま、無ければまとめる
  return KNOWN_METHOD_SET.has(method) ? method : OTHER_LABEL;
}

// 応答に使うステータスの集合（`HTTP_STATUS` が唯一の参照元）
const KNOWN_STATUSES: ReadonlySet<string> = new Set(
  Object.values(HTTP_STATUS).map((status) => String(status)),
);

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
 * テスト用にカウンタを空へ戻す。**本番では呼べない（fail-closed）** —
 * `setReposForTesting` と同じ扱いで、テストの独立性のためだけにある。
 */
export function resetMetricsForTesting(): void {
  // 本番ビルドで消されると運用の数字が黙って 0 へ戻るので拒否する
  if (process.env.NODE_ENV === 'production') {
    throw new Error('resetMetricsForTesting は本番では使えません。');
  }
  // 系列をすべて消す
  COUNTS.clear();
  // 捨てた数も戻す（`COUNTS` の外に持っているので別に消す）
  droppedSeries = 0;
}
