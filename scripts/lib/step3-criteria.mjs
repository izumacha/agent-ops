// Step3 の受け入れ基準のしきい値 (docs/roadmap.md の Step3 行が正本)。
// ベンチ (scripts/bench-evaluation.ts)・ゲート (scripts/gate-step3.mjs)・ロードマップとの
// 突き合わせ (tests/docs-gate.test.ts) がここを読む。数値を 3 か所に書き写すと必ずどれかが古くなる

// 再現率の下限 (%)。受け入れ基準「固定評価セット 100 件で採点の再現率 ≧ 90%」そのもの。
// **パーセントの整数で持つ**のは、許容する不一致件数を整数の計算だけで出すため
// (0.9 のような 2 進で表せない小数を挟むと、境界の 1 件が丸めで動く)
export const EVALUATION_AGREEMENT_MIN_PERCENT = 90;

// 再現率を測るときの評価セットの件数 (受け入れ基準の「100 件」)
export const EVALUATION_BENCH_CASE_COUNT = 100;

// **意図的に揺らすケース数。** スタブの judge は 2 回目の採点でこの件数だけ違うスコアを返す。
// 揺れが無いと一致率は必ず 100% になり、**計測そのものが何も検査しない**ので必ず 1 件以上にする。
// 8 件なら一致率 92% で基準 (90%) を満たしつつ、判定が実際に動いていることを示せる
export const EVALUATION_BENCH_FLIPPED_CASES = 8;

// 採点を依頼したケースのうち、2 回の結果が食い違ってよい**件数**の上限。
// **一致率ではなく件数で表す**のは、ゲートの共通判定 (benchOutputProblems) が
// 「実測値 ≦ 上限」の形しか扱わないため。整数だけで導くので境界が丸めで動かない
export function maxDisagreedCases(cases) {
  // 一致していなければならない最小の件数 (切り上げ。100 件 × 90% なら 90 件)
  const required = Math.ceil((cases * EVALUATION_AGREEMENT_MIN_PERCENT) / 100);
  // 残りが食い違ってよい件数 (100 件なら 10 件)
  return cases - required;
}

// 不正出力の除外テストの名前の接頭辞。tests/*.test.ts がこの接頭辞 + 除外理由でテストを作り、
// ゲートは「除外理由の enum の全種類ぶんが pass しているか」をこの名前で照合する
// (料金表からモデル名を導くのと同じ形。理由を足してテストを書き忘れたら落ちる)
export const EXCLUSION_TEST_PREFIX = '除外: ';
