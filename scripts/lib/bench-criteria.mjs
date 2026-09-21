// ベンチ (scripts/bench-*.ts) の判定そのもの。**スクリプト本体には数値判定を置かない** —
// 計測が成立したかを見る門番 (2xx 以外の件数・最小件数・捨て玉) も含めてすべてここが持つ。
// 本体に残すと、その 1 行を消しても検出網に映らない (実測で全件緑・件数も不変だった)。
//
// なぜ分けるか: ベンチのガードはスクリプトの中にあるため vitest の対象外で、**丸ごと消しても
// typecheck も lint も全テストも緑のまま**だった (実測。eslint は未使用の定数を warning にするが
// `eslint .` は --max-warnings を付けていないので exit 0)。ゲート本体に対して
// `scripts/lib/gate-report.mjs` ＋ `tests/gate-scripts.test.ts` が取っているのと同じ形にして、
// 判定を純粋関数へ出し、合成入力から挙動を固定する。
//
// **呼び出し行ごと消す変異は eslint が捕まえる** — import した名前が未使用になるため。
// ただし warning なので、`npm run lint` に `--max-warnings=0` が無いと exit 0 で握り潰される
// (実測: 2 本の判定を消すと vitest 675 緑・tsc 0・`eslint .` も 0、`eslint . --max-warnings=0`
// だけが 1 になった)。`package.json` の lint からその指定を外さないこと

// 受け入れ基準のしきい値 (値の正本は scripts/lib/step2-criteria.mjs)。
// **判定がここへ来る代わりに上限も自分で読む** — 呼び出し側から上限を受け取る形だと、
// 実測値と上限を入れ替えるだけで判定が反転し、どちらも number なので型検査も通ってしまう (実測)
import {
  PROXY_ADDED_LATENCY_P95_MAX_MS,
  USAGE_AGGREGATE_MAX_MS,
  USAGE_AGGREGATE_ROW_COUNT,
} from './step2-criteria.mjs';

// 捨て玉 (ウォームアップ) の最大遅延に置く上限 (ミリ秒)。
// **受け入れ基準の 50ms から導かない。** あちらは「プロキシ経由と直接の差」の予算で、こちらは
// 起動直後の絶対遅延。導出にすると、受け入れ基準を動かしたときに無関係なこの上限まで連動する。
// 値の根拠: 実測の初回コストは機械によって 88〜151ms (開発機・CI ランナー・レビュー機)。
// **捕まえたいのは桁が変わる悪化だけ**なので、その 3 倍以上の余裕を取って 500ms に置く
export const WARMUP_MAX_MS = 500;

/**
 * 環境変数の値を 0 以上の整数として読む。読めなければ理由を添えて例外にする (fail-closed)。
 * @param {string} name 変数名 (文言に出す)
 * @param {string | undefined} raw 生の値 (未設定なら undefined)
 * @param {number} fallback 未設定のときに使う既定値
 * @param {number} minimum 許す最小値
 * @returns {number} 読み取れた整数
 */
export function intFromEnvValue(name, raw, fallback, minimum) {
  // 未設定なら既定値 (空文字は「未設定」ではなく打ち間違いとして下で落とす)
  if (raw === undefined) return fallback;
  // **先に綴りを見る。** `Number('')` と `Number(' ')` は 0、`Number('0x10')` は 16、
  // `Number('2e2')` は 200 なので、`Number` の結果だけを見ると「10 進の整数」より緩くなる。
  // とくに空文字は minimum が 0 の変数 (捨て玉の件数) で 0 として通り、**捨て玉と、
  // それに掛かるガード 2 本がまとめて黙って外れる** (実測: `BENCH_WARMUP=` が警告なしで素通りした)
  // **文言に生の値を出すので、機密を持つ変数には使わない** (呼び出し元はベンチの調整値 3 つだけ)
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${name} は 10 進の整数で指定してください (今の指定: ${JSON.stringify(raw)})`);
  }
  // 10 進の整数として読む
  const parsed = Number(raw);
  // 下限未満は設定ミスとみなして止める
  if (parsed < minimum) {
    throw new Error(
      `${name} は ${minimum} 以上で指定してください (今の指定: ${JSON.stringify(raw)})`,
    );
  }
  // 読めた値
  return parsed;
}

/**
 * 捨て玉が指定どおりの件数で止まったかを判定する。
 * @param {number} expected 指定した件数
 * @param {number} actual 実際に流れた件数
 * @returns {string | null} 問題があれば文言、無ければ null
 */
export function warmupCountProblem(expected, actual) {
  // 一致していれば問題なし
  if (expected === actual) return null;
  // 件数が違う = 捨て玉が意図した形で回っていない (autocannon が amount より duration を優先する版へ
  // 変わった / 捨て玉の途中で接続が切れた 等)。どちらでも本計測の数字は信用できない
  return `捨て玉が指定の件数で止まりませんでした (指定 ${expected} 件 / 実際 ${actual} 件)。上流の失敗が無いかも確認してください`;
}

/**
 * 初回コスト (捨て玉側の最大遅延) が桁で悪化していないかを判定する。
 * 上限を引数で受け取らないのは下の addedLatencyProblem と同じ理由 (実測値と入れ替えられる)
 * @param {number} maxMs 捨て玉側の最大遅延
 * @returns {string | null} 問題があれば文言、無ければ null
 */
export function warmupLatencyProblem(maxMs) {
  // 上限以内なら問題なし
  if (maxMs <= WARMUP_MAX_MS) return null;
  // 上限を超えた = 初回コストが桁で悪化している
  return `初回コストが大きすぎます: 捨て玉の最大 ${maxMs}ms (上限 ${WARMUP_MAX_MS}ms)`;
}

// 本計測として成立する最小の件数 (これを下回る = ほとんど流せていないので数字を信用しない)。
// **受け入れ基準の値ではない** — 計測そのものが成立したかを見る門番なので、上の WARMUP_MAX_MS と同じ扱い。
// **`BENCH_DURATION` を既定の 10 秒から縮めるときはこの下限との関係を確かめること**
// (1 秒に縮めると遅い機械では 100 件に届かず、実装は正しいのにここで赤になる)
export const MIN_MEASURED_REQUESTS = 100;

/**
 * 2xx 以外の応答が 1 件も無かったかを判定する。
 * 失敗した要求は速く返るので、混ざると追加遅延が実力より良く出る (認証の取り違え等が黙って通る)
 * @param {number} non2xx 2xx 以外・エラー・タイムアウトの合計
 * @returns {string | null} 問題があれば文言、無ければ null
 */
export function non2xxProblem(non2xx) {
  // 1 件も無ければ問題なし
  if (non2xx === 0) return null;
  // あれば計測として成立していない
  return `2xx 以外の応答がありました (${non2xx} 件)。上流やキーの設定を確認してください`;
}

/**
 * 本計測が最低限の件数を流せたかを判定する。
 * 1 件だけ成功して p97.5 が 0ms、のような結果を通さない
 * @param {number} requests 流せた件数
 * @returns {string | null} 問題があれば文言、無ければ null
 */
export function measuredRequestsProblem(requests) {
  // 最小件数以上なら問題なし
  if (requests >= MIN_MEASURED_REQUESTS) return null;
  // 下回れば計測として成立していない
  return `計測が ${requests} 件しか流せていません (最低 ${MIN_MEASURED_REQUESTS} 件)`;
}

/**
 * 受け入れ基準「プロキシ経由の追加遅延 ≦ 上限」を判定する。
 *
 * **上限を引数で受け取らない。** 受け取る形にしていたときは、呼び出し側で実測値と上限を
 * 入れ替える (`addedLatencyProblem(上限, 実測値)`) だけで判定が反転し、どちらも number なので
 * 型検査も通り、全件緑のまま「基準を超えたときにだけ通る」状態になった (実測)。
 * 上限はこの関数が自分で読む
 * @param {number} addedMs 実測した追加遅延
 * @returns {string | null} 問題があれば文言、無ければ null
 */
export function addedLatencyProblem(addedMs) {
  // 上限以内なら問題なし
  if (addedMs <= PROXY_ADDED_LATENCY_P95_MAX_MS) return null;
  // 超えていれば受け入れ基準を満たしていない
  return `追加遅延が大きすぎます: ${addedMs}ms (上限 ${PROXY_ADDED_LATENCY_P95_MAX_MS}ms)`;
}

/**
 * 受け入れ基準「1 万件投入で日次集計 ≦ 上限」を判定する。上限と件数の出どころは上と同じ理由
 * @param {number} slowestMs 実測した最遅の所要時間
 * @returns {string | null} 問題があれば文言、無ければ null
 */
export function aggregateLatencyProblem(slowestMs) {
  // 上限以内なら問題なし
  if (slowestMs <= USAGE_AGGREGATE_MAX_MS) return null;
  // 超えていれば受け入れ基準を満たしていない
  return `集計が遅すぎます: ${slowestMs}ms (上限 ${USAGE_AGGREGATE_MAX_MS}ms、${USAGE_AGGREGATE_ROW_COUNT} 件)`;
}

// ベンチごとの受け入れ基準の表。**「どの値を、どの判定に掛けるか」の唯一の定義。**
//
// **要点は「判定へ渡す値を、出力 JSON に載せる値そのものから読む」こと。** 以前はベンチ本体が
// 判定を呼んで結果を渡す形だったため、渡す値を差し替えるだけで基準が無言の常時合格になった
// (実測: `const alwaysFine = 0;` を 1 行足して `aggregateLatencyProblem(alwaysFine)` にすると、
// 出力は本物の `slowestMs` を載せたまま `passed: true` になり、全件緑・件数も不変だった)。
// 値を payload から読む形なら、判定を騙すには**出力に載せる数字そのものを偽る**しかなく、
// そのときは結果の JSON を読めば分かる。
//
// 各項目の `fields` は payload から読む項目名 (判定の引数の順)、`judge` は判定そのもの
const BENCH_CRITERIA = {
  // プロキシの追加遅延ベンチ (scripts/bench-proxy.ts)
  'proxy-latency': [
    // 捨て玉が指定どおりの件数で止まったか (autocannon が amount を無視する版への変化を捕まえる)。
    // **計測ごとに別の基準にする** — 2 本を 1 つの数にまとめると、まとめ方 (最小値) が
    // 「件数が増える」向きの壊れ方を隠してしまい、片側だけが amount を無視した状態が黙って通る
    { fields: ['warmupRequests', 'warmupDirectRequests'], judge: warmupCountProblem },
    { fields: ['warmupRequests', 'warmupProxiedRequests'], judge: warmupCountProblem },
    // 初回コストが桁で悪化していないか (絶対遅延なので 2 本のうち遅いほうを見る)
    { fields: ['warmupSlowestMs'], judge: warmupLatencyProblem },
    // 失敗した要求が混ざっていないか (速く返るので追加遅延が実力より良く出る)
    { fields: ['non2xx'], judge: non2xxProblem },
    // 本計測が成立する件数を流せたか (計測ごとに見る)
    { fields: ['directRequests'], judge: measuredRequestsProblem },
    { fields: ['proxiedRequests'], judge: measuredRequestsProblem },
    // 受け入れ基準そのもの (追加遅延 ≦ 上限)
    { fields: ['addedMs'], judge: addedLatencyProblem },
  ],
  // 日次集計ベンチ (scripts/bench-usage-aggregate.ts)
  'usage-aggregate': [
    // 受け入れ基準そのもの (1 万件の集計 ≦ 上限)
    { fields: ['slowestMs'], judge: aggregateLatencyProblem },
  ],
};

/**
 * そのベンチのラベルが表に載っているか (載っていなければ設定ミス)。
 * @param {string} label ベンチのラベル
 * @returns {boolean} 表に載っていれば true
 */
export function isBenchLabel(label) {
  // 表のキーとして存在するか (プロトタイプ由来の名前を拾わないよう自前の項目だけを見る)
  return Object.hasOwn(BENCH_CRITERIA, label);
}

/**
 * 表のどれかの基準で実際に使われている判定を、**関数の同一性**で返す。
 * **なぜ要るか**: 基準を表から削り、挙動を固定する表の行も同時に削ると、判定は export も
 * describe も残ったまま「誰も掛けない判定」になり、痕跡はテスト件数の減少だけだった (実測)。
 * export されている判定がすべてここに現れることを検査すれば、外すには export ごと消すしかない
 * @returns {Set<Function>} 使われている判定
 */
export function benchCriteriaJudges() {
  // すべてのラベルの基準から判定を集める
  return new Set(Object.values(BENCH_CRITERIA).flatMap((list) => list.map(({ judge }) => judge)));
}

/**
 * そのベンチのラベルに紐づく受け入れ基準の一覧を返す (検査が表を導出に使うため)。
 * @param {string} label ベンチのラベル
 * @returns {{ fields: readonly string[] }[]} 基準ごとの読み取り項目
 */
export function benchCriteriaFields(label) {
  // 未知のラベルは設定ミス (fail-closed)
  if (!isBenchLabel(label)) throw new Error(`未知のベンチです: ${label}`);
  // 判定そのものは外へ出さず、読み取り項目だけを渡す
  return BENCH_CRITERIA[label].map(({ fields }) => ({ fields }));
}

/**
 * 計測結果 (payload) を、そのベンチの受け入れ基準すべてに掛けて問題の一覧を返す。
 *
 * **判定へ渡す値は payload からしか読まない** (上の BENCH_CRITERIA のコメント)。
 * 項目が欠けていたり数値でなければ、基準を黙って飛ばさず例外にする (§9 fail-closed) —
 * 項目名を打ち間違えたときに「基準を 1 つも満たさなくても緑」になるのを防ぐ
 * @param {string} label ベンチのラベル
 * @param {Record<string, unknown>} payload 計測結果
 * @returns {string[]} 満たしていない基準の文言 (すべて満たしていれば空配列)
 */
export function judgeBenchPayload(label, payload) {
  // 未知のラベルは設定ミス (fail-closed)
  if (!isBenchLabel(label)) throw new Error(`未知のベンチです: ${label}`);
  // 見つかった問題
  const problems = [];
  // 基準を順に掛ける
  for (const { fields, judge } of BENCH_CRITERIA[label]) {
    // 判定へ渡す実測値を payload から読む
    const values = fields.map((field) => {
      // **自前の項目だけを読む** — 継承した項目を許すと、`Object.create({ slowestMs: 0 })` の形で
      // 判定には 0 を読ませ、出力の `{ ...payload }` には載せない (own しか写らない) ことができた
      const value = Object.hasOwn(payload, field) ? payload[field] : undefined;
      // 数値として読めなければ判定できない (黙って飛ばさず落とす)
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${label} の計測結果に数値の ${field} がありません`);
      }
      // 読めた値
      return value;
    });
    // 判定を掛ける
    const problem = judge(...values);
    // 問題があれば覚える
    if (problem !== null) problems.push(problem);
  }
  // すべての問題
  return problems;
}

/**
 * ベンチを 1 本実行する。**計測・出力・判定・終了コードをここへ集約する。**
 *
 * ベンチ本体は「計測して payload を返す」だけにし、判定も出力も終了コードもここが持つ。
 * 分けていたときは、どの継ぎ目も 1 行で外せた (いずれも実測で全件緑・件数も不変):
 *   - 本体が判定を呼んで結果を渡す形にして、その結果を渡さない (`…(payload, null)`)
 *   - 実測値ではなく定数を入れた変数を渡す (`aggregateLatencyProblem(alwaysFine)`)
 *   - `process.exitCode = 1` を書いていた `main().catch(…)` からその 1 行を消す
 *     (`passed: false` を出したまま exit 0 になり、ゲートは終了コードしか見ないので緑)
 * ここに集めたことで、**基準を満たさない実測値を与えたら非 0 で終わる**ことを
 * tests/gate-scripts.test.ts が実際に呼んで固定できる (結線の綴りではなく挙動で押さえる)
 * @param {string} label ベンチのラベル (BENCH_CRITERIA のキー)
 * @param {() => Promise<Record<string, unknown>>} measure 計測して結果を返す関数
 * @returns {Promise<void>} 完了 (失敗しても throw せず process.exitCode で伝える)
 */
export async function runBench(label, measure) {
  // 計測そのものの失敗も受け入れ基準の未達も、同じ「非 0 で終わる」へ寄せる
  try {
    // 計測し、**自前の項目だけをその場で 1 回写し取る**。
    // **ここが「判定に渡す値＝出力に載る値」の要**: 写さずに元のオブジェクトを使うと、判定と
    // 出力で同じ項目を 2 回読むことになり、getter を仕込めば 1 回目 (判定) と 2 回目 (出力) で
    // 別の値を返せた (実測: 上限 1000ms に対し 999999ms を出しながら passed: true・exit 0)
    const payload = { ...(await measure()) };
    // 受け入れ基準に掛ける
    const problems = judgeBenchPayload(label, payload);
    // 人にもゲートにも読める形へ組み立てる (ラベルを先頭・passed を末尾にして読みやすくする)
    const output = { bench: label, ...payload };
    // **ラベルと passed は写し取ったあとに上書きする** — 並びだけで守ると payload 側の
    // 同名の項目に勝たれる (JS のオブジェクトは「位置は最初・値は最後」で決まる)
    output.bench = label;
    // 判定の結果から passed を導く (比較式の写しを作らない)
    output.passed = problems.length === 0;
    // 1 行の JSON として出す (ゲートがこの行を読む)
    console.log(JSON.stringify(output));
    // 満たしていない基準を 1 件ずつ理由として出す
    for (const problem of problems) console.error(`[bench:${label}]`, problem);
    // 1 件でもあれば非 0 で終わる
    if (problems.length > 0) process.exitCode = 1;
  } catch (error) {
    // 計測中の失敗は理由を出して非 0 で終わる
    console.error(`[bench:${label}]`, error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
