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

/**
 * 「モジュールの評価を遅らせる」待ち時間（ミリ秒）。
 *
 * 起動時刻の検査がこれだけ待ってからモジュールを読み直すので、**評価時刻を起点にしている
 * 実装はこの時間ぶんずれる**。短すぎると退行を拾えず、長すぎるとスイートが遅くなる。
 */
const MODULE_EVAL_DELAY_MS = 1_200;

/**
 * `statusLabel` が返しうる「級」の数（`2xx` / `3xx` / `4xx` / `5xx`）。
 *
 * **実装の配列を import せず、ここで数える** — 上界の導出を実装側の集合から取ると、
 * 級を減らす変異が導出も一緒に狭めて「上界を超えていない＝緑」で素通りする
 * （`KNOWN_METHODS` 自身から網羅を導いていた版が実際にそうだった）。級の数は HTTP の
 * ステータスが 1xx〜5xx の 5 クラスで、そのうち 1xx は応答として返さないので 4。
 */
const STATUS_CLASSES = 4;

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

  it('1 件も無いカウンタも宣言は出す（「まだ 0」と「名前が無い」を区別できる）', () => {
    // 何も数えずに書き出す
    const text = renderMetrics(new Date());
    // 宣言したカウンタはすべて現れる
    for (const name of Object.keys(COUNTERS)) {
      expect(text).toContain(`# HELP ${name} `);
      expect(text).toContain(`# TYPE ${name} counter`);
    }
  });

  it('ラベルを取るカウンタは、系列が無いあいだ標本を出さない', () => {
    // **ラベル無しの `<名前> 0` を出していた版の退行を固定する** — 1 件目が数えられた瞬間に
    // 同じカウンタがラベル付きとラベル無しの両方の形を持ち、ラベル無しの系列がそのまま
    // 古く残る（`sum by (status)` に空の `status` のバケツが現れる）
    expect(valueOf(renderMetrics(new Date()), 'agentops_http_responses_total')).toBeNull();
    // 1 件数えるとラベル付きの系列だけが現れる
    countHttpResponse('GET', HTTP_STATUS.OK);
    const text = renderMetrics(new Date());
    expect(text).toContain('agentops_http_responses_total{method="GET",status="200"} 1');
    // ラベル無しの標本は出ない
    expect(valueOf(text, 'agentops_http_responses_total')).toBeNull();
  });

  it('書き出した本文のどの行も、テキスト形式の 3 つの形のどれかである', () => {
    // 1 件数えてから（宣言・ラベル付きの標本・ラベル無しの標本が全部出る状態にする）
    countHttpResponse('GET', HTTP_STATUS.OK);
    incrementCounter('agentops_log_events_total', { event: 'x', level: 'error' });
    // 末尾の改行で分かれる空行を落として 1 行ずつ見る
    const lines = renderMetrics(new Date()).split('\n').slice(0, -1);
    // **行の文法を固定する** — 宣言の説明文に改行が入ると「続きが別の行になる」形で壊れるが、
    // 説明文は定数なのでテストから値を差し込めない。**行の形で見れば、改行が入った時点で
    // どちらの `# HELP` でも落ちる**（`escapeHelpText` が無い版は本文に素の改行を通す）
    const grammar =
      /^(# (HELP|TYPE) [a-z_]+ .+|[a-z_]+(\{[a-z_]+="[^"]*"(,[a-z_]+="[^"]*")*\})? -?[0-9.]+)$/;
    // 1 行も無ければ走査が壊れている
    expect(lines.length).toBeGreaterThan(0);
    // 文法から外れた行を名指しして落とす
    expect(lines.filter((line) => !grammar.test(line))).toEqual([]);
  });

  it('ラベルを取らないカウンタ（捨てた数）は 0 でも標本を出す', () => {
    // **こちらは常にラベル無しの 1 系列**なので、0 を出しても形が混ざらない
    // （「捨てていない」ことを見せる必要がある）
    expect(valueOf(renderMetrics(new Date()), 'agentops_metrics_series_dropped_total')).toBe(0);
  });

  it.each([
    ['引用符を含む名前', 'q"uote'],
    ['区切りの NUL を含む名前', 'a\u0000b'],
    ['数字で始まる名前', '1st'],
    ['ハイフンを含む名前', 'a-b'],
    ['空の名前', ''],
  ])('%s は出さずに捨てた系列として数える（出力を構文違反にしない）', (_label, name) => {
    // 出せない形のラベル名で数える
    incrementCounter('agentops_log_events_total', { [name]: 'v', level: 'error' });
    const text = renderMetrics(new Date());
    // その系列は 1 行も出ない（`agentops_log_events_total` の標本が無い）
    expect(text).not.toContain('agentops_log_events_total{');
    // 捨てたことは観測できる（黙って落とさない）
    expect(valueOf(text, 'agentops_metrics_series_dropped_total')).toBe(1);
  });

  it('出せる形のラベル名（下線始まり・数字入り）はそのまま出す（境界）', () => {
    // 仕様の文字集合に収まる名前
    incrementCounter('agentops_log_events_total', { _a1: 'v', level: 'error' });
    // 出力に現れる（名前の検査が広すぎて正しい名前を落としていないこと）
    expect(renderMetrics(new Date())).toContain(
      'agentops_log_events_total{_a1="v",level="error"} 1',
    );
  });

  it('ラベル値が文字列でなくても投げず、捨てた系列として数える', () => {
    // 型の外から数値のラベル値を渡す（JS からの呼び出し・将来のラベル追加がこの形）
    expect(() =>
      incrementCounter('agentops_log_events_total', {
        event: 'api.unexpected_error',
        attempt: 2 as unknown as string,
      }),
    ).not.toThrow();
    // 黙って消さず、捨てた系列として出力に現れる（§6 エラーを握り潰さない）
    expect(valueOf(renderMetrics(new Date()), 'agentops_metrics_series_dropped_total')).toBe(1);
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

  it('捨てた数のカウンタは COUNTS の外で数える（ラベルを渡しても系列を作らない）', () => {
    // **この分岐が上限の不変条件を保っている唯一の場所** — `COUNTS` の中で数えていた頃は、
    // 上限に達して**最初に**捨てるときにその系列を作るので `COUNTS.size` が上限を 1 本超えた。
    // 以前はこのカウンタを `renderMetrics` の出力からしか読んでおらず、
    // `incrementCounter` を直接呼ぶテストが 1 つも無かったので、**分岐を消しても全件緑**だった
    incrementCounter('agentops_metrics_series_dropped_total', { event: 'x', level: 'error' });
    const text = renderMetrics(new Date());
    // ラベル付きの系列は作られない（渡したラベルは無視される）
    expect(text).not.toContain('agentops_metrics_series_dropped_total{');
    // 値はラベル無しの 1 系列として増える
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

  // **逃がし方はテキスト形式が定義している 3 つだけ**（`\\` / `\"` / `\n`）。
  //
  // `\r` には定義が無く、出すと解析器が `invalid escape sequence` で**そのスクレイプ全体を
  // 捨てる** — 系列 1 本ではなくターゲットの数字がまるごと消える（区切りの NUL・不正な
  // ラベル名で塞いだのと同じ壊れ方を、塞ぐための関数が自分で作ってしまう形）。
  // だから **CR は LF と同じ `\n` へ畳む**
  it('ラベル値の逆斜線・二重引用符・改行を逃がす（CR も LF と同じ形へ畳む）', () => {
    // 行や引用の境目を壊しうる 4 文字を含む値を渡す（閉じた語彙から外れた値が来ても壊れない）
    incrementCounter('agentops_log_events_total', { event: 'a\\b"c\nd\re', level: 'error' });
    // 逃がした形で現れる（解析器が行や引用の境目を取り違えない）
    const text = renderMetrics(new Date());
    expect(text).toContain('agentops_log_events_total{event="a\\\\b\\"c\\nd\\ne",level="error"} 1');
    // **定義の無い逃がし方を 1 つも出さないこと** — 綴りで照合するだけでは「`\r` を足した」
    // 変異に気付かないので、出力全体から定義済みの 3 つを取り除いたうえで逆斜線が残らないことを見る
    const withoutDefined = text.replace(/\\[\\"n]/g, '');
    expect(withoutDefined.includes('\\\\'), '定義の無いエスケープが出ている').toBe(false);
  });

  it('ラベル値の NUL で出力が壊れない（キーの区切りと衝突させない）', () => {
    // **実測**: 以前はキーを同じ文字で割り直していたので、値の中の NUL が余分な区切りになり
    // `{event="a",="b",level="error"}` という**ラベル名が空の標本**が出た。Prometheus は
    // その行だけでなく**そのターゲットのスクレイプ全体を捨てる**ので、監視が丸ごと止まる
    incrementCounter('agentops_log_events_total', { event: 'a\u0000b', level: 'error' });
    // 書き出した行
    const line = renderMetrics(new Date())
      .split('\n')
      .find((text) => text.startsWith('agentops_log_events_total{'));
    // ラベル名が空の項目が無いこと（`,="` や `{="` が現れない）
    expect(line).not.toMatch(/[{,]="/);
    // 値は置換文字として読める形で残る（潰して隠さない）
    expect(line).toBe('agentops_log_events_total{event="a\uFFFDb",level="error"} 1');
  });

  it('逃がさなければ行が割れる文字が、1 つも生のまま出ない', () => {
    // **規則の 3 文字を数え上げるのではなく「行が割れないこと」を見る** — CR は規則の一覧に
    // 無いので、綴りを数える検査では落ちない（CRLF で行を割る収集側は値の途中で切るか
    // 行ごと捨てる＝その系列が黙って落ちる）
    incrementCounter('agentops_log_events_total', { event: 'x\ry', level: 'error' });
    // 書き出した本文の行数は、生の CR が残っていれば増える
    const lines = renderMetrics(new Date()).split('\n');
    // どの行にも生の CR が無いこと
    expect(lines.some((line) => line.includes('\r'))).toBe(false);
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

  // **プロセスの起動時刻は `process.uptime()` と突き合わせる。**
  //
  // 手掛かりを出力の `..._start_time_seconds` 側から取ると（それで稼働秒数を検算する形）
  // **同じ値を自分自身と比べるだけ**になり、`Date.now()` をそのまま入れる退行を 1 件も
  // 拾えない（実測で、プロセスは 35 秒生きているのに稼働秒数が 29.774 を返す状態が
  // 全件緑だった）。`process.uptime()` は Node が持つ独立な手掛かり。
  //
  // **モジュールを遅らせて読み直すのが要点。** このファイルの静的 import は vitest の
  // ワーカー起動の直後に評価されるので、`Date.now()` でも差はミリ秒しか出ない
  // （実測で、素の `Date.now()` へ戻す変異が全件緑で通った）。待ってから**新しい
  // モジュール実体**を読めば、「評価時刻を起点にしている実装」だけがその待ち時間ぶん
  // ずれる。サーバーレスのコールドスタートで実際に起きるのがこのずれ。
  it('稼働秒数はプロセスの起動からの経過と一致する（モジュールの評価時刻ではない）', async () => {
    // 評価の遅れを作る（この待ち時間がそのまま「ずれ」の下限になる）
    await new Promise((resolve) => setTimeout(resolve, MODULE_EVAL_DELAY_MS));
    // モジュールの登録簿を捨てて読み直す（新しい実体が「いま」評価される）
    vi.resetModules();
    const fresh = (await import('@/lib/metrics')) as typeof import('@/lib/metrics');
    // 読み直した実体で書き出す
    const text = fresh.renderMetrics(new Date());
    // 出力の稼働秒数
    const reported = valueOf(text, 'agentops_process_uptime_seconds');
    expect(reported).not.toBeNull();
    // Node が報告するプロセスの経過秒数（**別の手掛かり**）
    const actual = process.uptime();
    // 差は待ち時間より十分小さいこと。評価時刻を起点にしている実装では
    // `reported` がほぼ 0 になるので、この差が待ち時間ぶん開いて落ちる
    expect(Math.abs(reported! - actual)).toBeLessThan(MODULE_EVAL_DELAY_MS / 1_000 / 2);
  });

  it('起動時刻は「いま − 稼働秒数」と一致する（2 つのゲージが同じ原点を指す）', () => {
    // 同じ時刻で両方を書き出す
    const now = new Date();
    const text = renderMetrics(now);
    const start = valueOf(text, 'agentops_process_start_time_seconds');
    const uptime = valueOf(text, 'agentops_process_uptime_seconds');
    expect(start).not.toBeNull();
    expect(uptime).not.toBeNull();
    // 起動時刻 + 稼働秒数 = いま（原点が食い違っていれば開く）
    expect(Math.abs(start! + uptime! - now.getTime() / 1_000)).toBeLessThan(0.01);
  });

  // **稼働秒数は壁時計に依存しない。**
  //
  // `いま − 起動時刻` で求めていた版は、NTP が壁時計を稼働秒数より大きく巻き戻すと**負の値**を
  // 書き出した（実測で `-1791547215.343`）。負になると用途が反転し、`< 60`（再起動の検出）の
  // 警報が実体の無い再起動で鳴る。**巻き戻しは書き出す時刻を過去にして再現できる**
  it('稼働秒数は壁時計の巻き戻しで負にならない（モノトニックな時計から求める）', () => {
    // 1 年前の時刻で書き出す（壁時計が大きく巻き戻った配備と同じ）
    const rewound = new Date(Date.now() - 365 * 24 * 3_600 * 1_000);
    const uptime = valueOf(renderMetrics(rewound), 'agentops_process_uptime_seconds');
    expect(uptime).not.toBeNull();
    // 負にならず、Node が報告する経過秒数と一致する（**別の手掛かり**）
    expect(uptime!).toBeGreaterThanOrEqual(0);
    expect(Math.abs(uptime! - process.uptime())).toBeLessThan(1);
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

  it.each([999, 0, -1])('級も決まらない番号 (%i) は 1 つにまとめる', (status) => {
    // **まとめ先は 1 本だけ**（系列を外から増やせる形を残さない）。
    // `HTTP_STATUS` に無いが級が決まる番号は `other` ではなく級へ入る（下の describe が見る）
    expect(statusLabel(status)).toBe(OTHER_LABEL);
  });
});

describe('応答を数える入口', () => {
  it('メソッドとステータスを閉じた集合へ写してから数える', () => {
    // 既知のメソッド・既知のステータス
    countHttpResponse('POST', HTTP_STATUS.CREATED);
    // 未知のメソッド・`HTTP_STATUS` に無い番号（メソッドはまとめ先、ステータスは級へ入る）
    countHttpResponse('TRACE', 418);
    // 書き出して確かめる
    const text = renderMetrics(new Date());
    expect(
      valueOf(text, `agentops_http_responses_total{method="POST",status="${HTTP_STATUS.CREATED}"}`),
    ).toBe(1);
    expect(
      valueOf(text, `agentops_http_responses_total{method="${OTHER_LABEL}",status="4xx"}`),
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

describe('ステータスのラベル', () => {
  it('アプリ自身が返す番号はそのまま出す', () => {
    // `HTTP_STATUS` にある値は 1 件ずつ読みたい
    expect(statusLabel(HTTP_STATUS.OK)).toBe('200');
    expect(statusLabel(HTTP_STATUS.UNAUTHORIZED)).toBe('401');
  });

  it('中継した上流の番号は級へ丸める（まとめ先 other と混ぜない）', () => {
    // **`other` は「未知・敵対的な値のまとめ先」**。中継（`canRelayStatus` は 300 未満を
    // 無条件に通す）が返す成功した 2xx を同じバケットへ入れていた頃は、`status="other"` の
    // 増加で警報を組むと成功で誤発火し、本当に未知の値は成功分に埋もれた
    expect(statusLabel(202)).toBe('2xx');
    expect(statusLabel(206)).toBe('2xx');
    expect(statusLabel(301)).toBe('3xx');
    expect(statusLabel(418)).toBe('4xx');
    expect(statusLabel(507)).toBe('5xx');
    // どれも `other` ではない（混ぜないことが要点）
    expect([202, 206, 301, 418, 507].map(statusLabel)).not.toContain(OTHER_LABEL);
  });

  it('級の決まらない値だけが other になる', () => {
    // `Response` の status は 200〜599 なので普通の経路では来ないが、来たらまとめ先へ
    expect(statusLabel(0)).toBe(OTHER_LABEL);
    expect(statusLabel(99)).toBe(OTHER_LABEL);
    expect(statusLabel(600)).toBe(OTHER_LABEL);
    expect(statusLabel(Number.NaN)).toBe(OTHER_LABEL);
  });
});

describe('系列数の上限', () => {
  // **上限の根拠を正本から導く**（metrics.ts の docstring に算術を書き写すと、語彙を増やした
  // ときにそこだけが古くなる。以前は「メソッド 5 種 × ステータス約 15 種 = 75」と書いてあり、
  // まとめ先の `other` を数えておらず実際の上界と合っていなかった）
  it('いま数えうる系列の上界より十分に大きい', () => {
    // (a) 応答 = メソッドの値（既知 + まとめ先）× ステータスの値（既知 + 級 + まとめ先）
    const methods = KNOWN_METHODS.length + 1;
    const statuses = new Set(Object.values(HTTP_STATUS)).size + STATUS_CLASSES + 1;
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
    // 戻すと系列が消える（宣言だけが残り、標本は 1 本も出ない）
    resetMetricsForTesting();
    const text = renderMetrics(new Date());
    expect(text).toContain('# TYPE agentops_http_responses_total counter');
    expect(text).not.toContain('agentops_http_responses_total{');
    expect(valueOf(text, 'agentops_http_responses_total')).toBeNull();
  });
});
