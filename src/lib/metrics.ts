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
  agentops_log_events_total:
    'ログに出した出来事の数 (event / level 別。Route Handler の束が実行した分だけ)',
  // 系列の上限を超えて捨てた増加の数（0 でないときはラベルの設計を間違えている）
  agentops_metrics_series_dropped_total: '系列数の上限を超えて捨てたカウントの数',
} as const;

/** カウンタの名前 */
export type CounterName = keyof typeof COUNTERS;

/** ゲージ 1 本の宣言（カウンタと違って積み上げず、読んだ瞬間の値を出す） */
interface GaugeSpec {
  // `# HELP` に出る説明
  readonly help: string;
  // 出す値。**`renderMetrics` に渡された時刻を受け取れる**が、使わないゲージは引数を
  // 宣言しない（稼働秒数は壁時計に依存しないので Node のモノトニックな時計から読む）
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
  // 稼働秒数。スクレイプの間隔より短い再起動を見落とさないために添える。
  // **壁時計ではなく Node のモノトニックな時計から読む。** `いま − 起動時刻` で求めていた
  // 版は、NTP が壁時計を稼働秒数より大きく巻き戻すと**負の値**を書き出した（実測で
  // `agentops_process_uptime_seconds -1791547215.343`）。負になると「再起動を見つける」
  // という本来の用途が反転し（`< 60` の警報が実体の無い再起動で鳴る）、同じ原点を指す
  // `..._start_time_seconds` は未来を指す。**この PR は同じ危険を間引きの窓では手当てして
  // いる**（`src/lib/log.ts` の `elapsed >= 0`）ので、ここだけ壁時計に頼る理由が無い。
  // 引数の `now` は使わない（書き出す時刻に依存しない値なので）
  agentops_process_uptime_seconds: {
    help: 'プロセスの稼働秒数',
    value: () => process.uptime(),
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
  // ラベルを名前順に並べて `名前=値` の列にする（**値から区切り文字を除く**。理由は下記）
  const pairs = Object.keys(labels)
    .sort()
    .map((label) => `${label}=${withoutKeySeparator(labels[label] ?? '')}`);
  // カウンタ名と連結する
  return [name, ...pairs].join(KEY_SEPARATOR);
}

/**
 * キーの区切りに使う文字を値から除く。
 *
 * **この 1 行が無いと、ラベル値に NUL が 1 つ入るだけで出力全体が壊れる**（実測）。
 * `renderMetrics` はキーを同じ区切りで割り直すので、値の中の NUL が余分な区切りになり、
 * その断片に `=` が無いまま**ラベル名が空の標本**（`{event="a",="b",level="error"}`）が出る。
 * Prometheus はその行だけでなく**そのターゲットのスクレイプ全体を捨てる**ので、系列が
 * 1 本壊れるのではなく監視が丸ごと止まる。
 *
 * `escapeLabelValue` は「将来うっかり可変の値を渡しても出力が壊れない」ために `\` / `"` /
 * 改行を逃がしているが、**区切り文字だけはその保証から漏れていた** — あれは出力のときに
 * 掛かるので、キーの段で崩れた構造は直せない。
 *
 * 置き換え先は U+FFFD（置換文字）。閉じた語彙の値に NUL は現れないので、見えたら呼び出し側の
 * 不具合であり、**潰して隠すのではなく読める形で残す**。
 * @param value ラベル値
 * @returns 区切り文字を含まない値
 */
function withoutKeySeparator(value: string): string {
  // 区切りに使う文字だけを置換文字へ替える
  return value.replaceAll(KEY_SEPARATOR, '\uFFFD');
}

// Prometheus のラベル名として許される形（テキスト形式の仕様。`[a-zA-Z_][a-zA-Z0-9_]*`）
const LABEL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * ラベル「名」が Prometheus のラベル名として出せる形か。
 *
 * **値の側だけ無害化していたのが非対称だった。** `withoutKeySeparator` は値から区切りを除き、
 * `escapeLabelValue` は値の `\` / `"` / 改行を逃がすが、**名前はどちらも通っていなかった**
 * （実測: 名前に `"` を入れると `…{level="error",q"uote="v"} 1` という構文違反の行が出て、
 * Prometheus はその系列ではなく**そのターゲットのスクレイプ全体を捨てる**。名前に区切りの
 * NUL を入れると断片が増え、`=` を持たない断片から**架空のラベルが捏造された**）。
 *
 * **名前は「逃がす」ことができない**（仕様が文字集合を決めているので、エスケープという概念が
 * 無い）。だから値と違って置換はせず、**形が違えばその計数ごと捨てて「捨てた系列」として
 * 数える**（§9 fail-closed。黙って名前を潰すと、別の名前が同じ系列へ合流しうる）。
 * いまの呼び出し側はどれも閉じた語彙の名前を渡すので、ここに掛かるのは呼び出し側の不具合。
 * @param name ラベル名
 * @returns 出せる形なら true
 */
function isRenderableLabelName(name: string): boolean {
  // 仕様の文字集合に一致するかだけを見る
  return LABEL_NAME_PATTERN.test(name);
}

/**
 * カウンタを 1 つ増やす。
 *
 * **絶対に例外を投げない** — 呼び出し元は `catch` の中やログの経路なので、ここで throw すると
 * 本来の失敗が別の失敗に化ける（`describeError` が throw しないのと同じ理由）。
 *
 * **その約束は型だけでなく try/catch で支える。** 以前は本体が素のままで、約束を支えていたのは
 * `MetricLabels` の型と 2 つの呼び出し元（`methodLabel` / `statusLabel` / 語彙の `level`）が
 * 文字列を渡すことだけだった。**姉妹の `describeError` / `formatLogLine` は同じ約束を
 * try/catch で支えている**のに、ここだけ構造が違った。破れると困る場所が 2 つあり、どちらも
 * 呼び出しは `try` の外にある: (a) `src/lib/api/response-count.ts` は組み立て済みの応答を
 * 返す直前に呼ぶので、throw すると**応答ごと捨てられ**統一された 500 も
 * `api.unexpected_error` のログも飛ぶ（この PR が `withPrivateCacheHeaders` を `try` の中へ
 * 移して塞いだ形が戻る）、(b) `src/lib/log.ts` の `logEvent` は `console.error` より**前**に
 * 呼ぶので、`src/lib/prisma-client.ts` の `onPoolError`（要求の外）から来た場合は
 * **ログ行が 1 文字も出ないまま uncaught でプロセスが落ちる**。
 *
 * **失敗は黙って捨てず「捨てた系列」として数える**（§6 エラーを握り潰さない）。出力に
 * `agentops_metrics_series_dropped_total` が立つので、数え損ないが外から見える。
 * @param name カウンタ名
 * @param labels ラベル（省略時はラベル無しの 1 系列）
 */
export function incrementCounter(name: CounterName, labels: MetricLabels = {}): void {
  // 捨てた数は専用の変数が持つ（`COUNTS` の外。ラベルは取らない）
  if (name === DROPPED_COUNTER) {
    droppedSeries += 1;
    return;
  }
  try {
    // **ラベル名の形を先に確かめる** — 出せない名前が 1 つでもあれば出力が構文違反になり、
    // スクレイプ全体が捨てられる。捨てた系列として数え、その計数は行わない（fail-closed）
    if (!Object.keys(labels).every(isRenderableLabelName)) {
      droppedSeries += 1;
      return;
    }
    // 系列のキーを作る（ここだけが呼び出し側の値に触るので、失敗しうるのもここ）
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
  } catch {
    // 鍵を組み立てられなかった（型の外から文字列でないラベル値が来た等）。
    // **投げ直さず、捨てた系列として数える** — 呼び出し元の 2 か所が throw を前提にしていない
    droppedSeries += 1;
  }
}

// 数えない応答の種類（既知の非可視）の一覧は **`src/lib/uncounted-response-sources.ts`** が正本。
// **ここから import しない** — この表を読むのはテストと文書だけなのに、このモジュールは
// 全 Route Handler・入口の proxy・seed へ入るので、同梱すると説明文がすべてのバンドルへ載る。

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
 * **数えないものは `UNCOUNTED_RESPONSE_SOURCES` が正本**（種類も件数もここへ写さない。
 * 写した側が先に古くなる）。この系列だけを見て「アプリの HTTP 通信はすべて覆われている」と
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
 * `# HELP` の説明文を 1 行に収める。
 *
 * **ラベル値とは規則が違う** — 説明文は行末までが本文なので二重引用符は逃がさず、
 * 逃がすのは**行を割りうるもの**（`\` と改行 LF / CR）だけ。いま渡しているのは
 * `COUNTERS` / `GAUGES` の定型文なので改行は入っていないが、説明を書き足した人が
 * うっかり改行を入れたときに**その 1 行から先が壊れる**（続きが別の行として解析される）。
 * @param text 逃がす前の説明文
 * @returns 逃がした後の説明文
 */
function escapeHelpText(text: string): string {
  // 逆斜線と改行（LF / CR）だけを逃がす
  return text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
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
    lines.push(`# HELP ${name} ${escapeHelpText(COUNTERS[name])}`);
    lines.push(`# TYPE ${name} counter`);
    // 捨てた数だけは `COUNTS` の外（上限の外）に持つので、ここは変数から出す
    if (name === DROPPED_COUNTER) {
      lines.push(`${name} ${droppedSeries}`);
      continue;
    }
    // この名前の系列
    const series = grouped.get(name) ?? [];
    // **系列が無ければ標本を出さない**（宣言だけを出す）。
    // ラベル無しの `<名前> 0` を出していた版では、1 件目が数えられた瞬間に
    // **同じカウンタがラベル付きとラベル無しの両方の形を持つ**ことになり、ラベル無しの系列が
    // そのまま古く残る（`sum by (status)` に空の `status` のバケツが現れる）。
    // 宣言（HELP / TYPE）を出してあれば「まだ 0」と「名前が無い」はスクレイプ側で区別できる
    if (series.length === 0) continue;
    // 系列をキー順に並べて出す（同じ状態なら同じ出力になるようにする）
    for (const { labels, value } of series.sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    )) {
      // `名前=値` を Prometheus の `名前="値"` へ直す（値に `=` が入っても最初の 1 つだけで割る）。
      // **断片が必ず `=` を 1 つ持つことは入口が保証している** — `incrementCounter` が
      // ラベル名を仕様の文字集合（`=` も区切りも含まれない）に限り、値からは区切りを除くので、
      // 区切りで割った断片は必ず結合時の `=` を持つ。以前は名前が素通しで、`=` を持たない
      // 断片に `slice(0, -1)` / `slice(0)` が当たって**架空のラベルを捏造していた**（実測）。
      // **ここに `at === -1` の門番は置かない** — 入口を直した今は到達せず、外しても全件緑に
      // なる（実測）。どのテストにも守られない門番は「守られている」と誤解させるだけなので、
      // 不変条件は入口の `isRenderableLabelName` が持ち、その検査が 5 件で固定されている
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
    lines.push(`# HELP ${name} ${escapeHelpText(GAUGES[name].help)}`);
    lines.push(`# TYPE ${name} gauge`);
    // **宣言を `GaugeSpec` として受け直してから呼ぶ。** 表の値は `as const` で推論されるので、
    // すべてのゲージが `now` を使わなくなると**この呼び出しだけが型エラー**になる
    // （引数を取らない関数の合併になる）。契約は「書き出す時刻を受け取れる」ままにしておき、
    // 使わないゲージはその引数を宣言しない（受け取って捨てる形にすると「使っているつもり」の
    // 読み違いを招く）
    const gauge: GaugeSpec = GAUGES[name];
    lines.push(`${name} ${gauge.value(now).toFixed(3)}`);
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
 * **`HEAD` を入れる理由（実測）**: Next.js の App Router は `HEAD` を **`GET` のハンドラを
 * 呼んで**応えるので、export が無くてもラッパーに届く。つまり「export の無いメソッドは 405 で
 * 届かない」は成り立たず、外していた版では死活監視の `HEAD` が**未知・敵対的なメソッド用の
 * まとめ先 `other`** に積まれていた（警報に使える信号ではなくなる）。
 *
 * **`OPTIONS` を入れる理由は `HEAD` とは違う。** Next.js が自分で実装する `OPTIONS` は
 * **ラッパーを通らない**（だから数えられない。`UNCOUNTED_RESPONSE_SOURCES` の
 * `frameworkSynthesized`）。ここに入れてあるのは**ルートが自分で `OPTIONS` を export した
 * とき**のためで、そのときは他の export と同じくラッパーを通る（`tests/route-wrapping.test.ts`
 * が全 export に印を要求する）。いま export しているルートは 1 本も無いので、この値は
 * **出るとしたらそのときだけ**。「Next が自分で実装するから入れる」という以前の説明は
 * 向きが逆で、読み手に「自動の `OPTIONS` も数えられている」と誤読させる。
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
 * ラベルに使える「ステータスの級」。
 *
 * **`HTTP_STATUS` に無い番号を `other` へまとめると、`other` の意味が割れる。**
 * あれは「未知・敵対的な値のまとめ先」として設計した値だが、中継（`proxy-route.ts`）は
 * 上流の 2xx を**そのまま**返すので（`canRelayStatus` は 300 未満を無条件に通す）、
 * `HTTP_STATUS` が持たない 202 / 206 / 207 の**成功した中継**が同じバケットへ入っていた
 * （実測: `statusLabel(202)` が `other`）。`status="other"` の増加で警報を組むと成功で
 * 誤発火し、逆に本当に未知の値が来たときは成功分に埋もれる。
 *
 * 級へ丸めれば集合は閉じたまま（+4 値）で、成功した中継は `2xx` として読める。
 */
// **1xx は入れない** — `Response` の status は 200〜599 なので応答として返らない
const STATUS_CLASS_LABELS = ['2xx', '3xx', '4xx', '5xx'] as const;

/** 級に丸めるときの桁（HTTP のステータスは 3 桁） */
const STATUS_CLASS_DIVISOR = 100;

/**
 * ステータスをラベル値へ写す。
 *
 * 1. `HTTP_STATUS` にある番号はその値（アプリ自身が返すものは 1 件ずつ読みたい）。
 * 2. それ以外で級が**閉じた集合にある**もの（200〜599）は級（`2xx` 等）。上流から中継した
 *    番号がここへ来る。
 * 3. どちらでもない値は `other`（**未知・敵対的な値のまとめ先**。`Response` の status は
 *    200〜599 の整数に限られるので、1xx も範囲外も普通の経路ではここへ来ない）。
 *
 * **非整数は `other` にならない。** 級は `Math.floor(status / 100)` で出すので `200.5` は
 * `2xx` に入る（`other` へ来るのは `NaN` と範囲外だけ）。`Response.status` は必ず整数なので
 * 現在の呼び出し元では起きないが、**上流が申告した番号のような別の出どころへ広げるときは
 * 呼び出し側で整数に正規化する**（ここを「非整数も `other`」と書いていたので直した）。
 * @param status 応答のステータス
 * @returns ラベル値
 */
export function statusLabel(status: number): string {
  // 文字列にしてから閉じた集合と照合する
  const text = String(status);
  // アプリ自身が返す番号はそのまま
  if (KNOWN_STATUSES.has(text)) return text;
  // 級に丸める（`2xx` 等）。整数でない・範囲外は級が決まらない
  const label = `${Math.floor(status / STATUS_CLASS_DIVISOR)}xx`;
  // 閉じた集合にある級ならそれを使い、無ければまとめ先へ
  return (STATUS_CLASS_LABELS as readonly string[]).includes(label) ? label : OTHER_LABEL;
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
