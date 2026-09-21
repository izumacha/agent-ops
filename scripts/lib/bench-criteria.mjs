// ベンチ (scripts/bench-*.ts) の判定そのもの。**スクリプト本体には数値判定を置かない。**
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
 * @param {number} maxMs 捨て玉側の最大遅延
 * @param {number} limitMs 上限
 * @returns {string | null} 問題があれば文言、無ければ null
 */
export function warmupLatencyProblem(maxMs, limitMs) {
  // 上限以内なら問題なし
  if (maxMs <= limitMs) return null;
  // 上限を超えた = 初回コストが桁で悪化している
  return `初回コストが大きすぎます: 捨て玉の最大 ${maxMs}ms (上限 ${limitMs}ms)`;
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

/**
 * 判定の結果を受け取り、問題があればその場で throw する。
 *
 * **判定と throw を分けたうえで、throw をここへ集約するのが要点。** ベンチ本体に
 * `if (problem !== null) throw new Error(problem)` と書けると、条件を 1 つ足すだけで
 * 受け入れ基準の強制が外れ、全件緑のまま通る (実測)。ここに集めれば結線の検査が効く。
 * 出力 JSON の `passed` も判定の戻り値から導けるので、比較式の写しも消える (§6 DRY)
 * @param {string | null} problem 判定の結果 (問題が無ければ null)
 */
export function requireNoProblem(problem) {
  // 問題が無ければ何もしない
  if (problem === null) return;
  // あれば受け入れ基準を満たしていないので止める
  throw new Error(problem);
}
