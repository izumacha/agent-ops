// gate:stepN の「受け入れ基準を満たしているか」の判定だけを取り出した純粋関数群。
//
// スクリプト本体に判定を書き下すと、値 (件数の下限) も判定そのものも黙って外せてしまう
// — 実測では `REQUIRED_PASSED_TESTS` を小さくしても、`if (...)` を `if (false && ...)` にしても
// ゲートは緑のまま通り、テスト件数も変わらなかった。ここへ出せば挙動をユニットテストで固定できる
// (tests/gate-scripts.test.ts)。**残る境界**: 「この関数を呼ばない」形に書き換える変異は署名からは
// 見分けられないので、そこは規約とレビューで守る。

/**
 * vitest の JSON レポートから、「この名前を含む pass したテスト」が見つからない項目を返す。
 * 名前の作り方だけを呼び出し側から受け取り、走査と判定はここに 1 つだけ置く
 * (RBAC 行列と料金表で同じ走査を書き写していたので、片方を直したときにもう片方が取り残される形だった)。
 * @template T 期待する項目の型
 * @param {{ testResults?: { assertionResults?: { fullName?: string, status?: string }[] }[] }} report vitest の JSON レポート
 * @param {T[]} expected 期待する項目の一覧
 * @param {(item: T) => string} needleOf その項目に対応するテスト名の一部
 * @param {(item: T) => string} labelOf 不足として表示するときの名前
 * @returns {string[]} 見つからない・落ちている項目のラベル (すべて揃っていれば空)
 */
function missingPassedCases(report, expected, needleOf, labelOf) {
  // 全テストの (フルネーム, 結果) を平坦化する
  const results = (report.testResults ?? []).flatMap((file) =>
    (file.assertionResults ?? []).map((test) => ({ name: test.fullName, status: test.status })),
  );
  // 見つからない・落ちている項目を集める
  const missing = [];
  // 期待する項目をすべて見る
  for (const item of expected) {
    // その項目に対応するテスト名の一部
    const needle = needleOf(item);
    // 名前にそれを含む pass したテストがあるか
    const hit = results.find(
      (test) =>
        typeof test.name === 'string' && test.name.includes(needle) && test.status === 'passed',
    );
    // 無ければ不足として記録する
    if (!hit) missing.push(labelOf(item));
  }
  // 不足の一覧
  return missing;
}

/**
 * RBAC 行列 (役割 × 操作) のうち、pass したテストが見つからない組を返す。
 * @param {{ testResults?: { assertionResults?: { fullName?: string, status?: string }[] }[] }} report vitest の JSON レポート
 * @param {{ roles: string[], actions: string[], matrixPrefix: string }} matrix 期待する組み合わせ
 * @returns {string[]} 「役割 × 操作」の文字列の配列 (すべて揃っていれば空)
 */
export function missingMatrixCases(report, { roles, actions, matrixPrefix }) {
  // 役割 × 操作をすべて組み合わせる
  const pairs = roles.flatMap((role) => actions.map((action) => ({ role, action })));
  // 「RBAC 行列: <役割> × <操作>」を含む pass したテストがあるか
  return missingPassedCases(
    report,
    pairs,
    ({ role, action }) => `${matrixPrefix}${role} × ${action}`,
    ({ role, action }) => `${role} × ${action}`,
  );
}

/**
 * 料金表の各モデルについて、pass した「誤差 0」のテストが見つからないものを返す。
 * **期待するテスト名は料金表 (正本の JSON) から導く** — 一覧をここに書き写すと、
 * モデルを足した人がテストを書き忘れてもゲートは緑のままになる。
 * @param {{ testResults?: { assertionResults?: { fullName?: string, status?: string }[] }[] }} report vitest の JSON レポート
 * @param {{ models: { provider: string, model: string }[], pricePrefix: string }} pricing 料金表とテスト名の接頭辞
 * @returns {string[]} 「provider model」の文字列の配列 (すべて揃っていれば空)
 */
export function missingPriceCases(report, { models, pricePrefix }) {
  // 「料金: <provider> <model>」を含む pass したテストがあるか
  return missingPassedCases(
    report,
    models,
    ({ provider, model }) => `${pricePrefix}${provider} ${model}`,
    ({ provider, model }) => `${provider} ${model}`,
  );
}

/**
 * Step1 の受け入れ基準を満たしているかを判定し、満たさない理由をすべて返す。
 * @param {object} input 判定材料
 * @param {number} input.testStatus `npm run test` の終了コード
 * @param {object} input.report vitest の JSON レポート
 * @param {number} input.requiredPassedTests pass したテストの下限
 * @param {string[]} input.roles 役割の一覧
 * @param {string[]} input.actions 操作の一覧
 * @param {string} input.matrixPrefix RBAC 行列テストの名前の接頭辞
 * @returns {string[]} 失敗の理由 (基準を満たしていれば空)
 */
export function evaluateStep1Report({
  testStatus,
  report,
  requiredPassedTests,
  roles,
  actions,
  matrixPrefix,
}) {
  // 失敗の理由をためる
  const failures = [];
  // テストの実行そのものが失敗していないこと
  if (testStatus !== 0 || report.numFailedTests !== 0) failures.push('テストが落ちています');
  // pass した件数が下限以上であること
  if (!(report.numPassedTests >= requiredPassedTests)) {
    failures.push(`pass したテストが ${requiredPassedTests} 件未満です`);
  }
  // RBAC 行列の全パターンが存在し pass していること
  const missing = missingMatrixCases(report, { roles, actions, matrixPrefix });
  if (missing.length > 0) failures.push(`RBAC 行列のテストが不足/失敗: ${missing.join(', ')}`);
  // 判定結果
  return failures;
}

/**
 * Step2 の受け入れ基準のうち、テストレポートから判定できるぶんを見る。
 * Step1 の基準 (件数・RBAC 行列・失敗 0) は**引き継ぐ** — ゲートは常に最新 Step のものだけを回すので、
 * ここで引き継がないと Step1 の基準が誰にも見られなくなる (docs/roadmap.md のゲート運用ルール 2)。
 * 遅延と集計の基準はテストではなくベンチ (scripts/bench-*.ts) が測るので、ここでは扱わない。
 * @param {object} input 判定材料
 * @param {number} input.testStatus `npm run test` の終了コード
 * @param {object} input.report vitest の JSON レポート
 * @param {number} input.requiredPassedTests pass したテストの下限
 * @param {string[]} input.roles 役割の一覧
 * @param {string[]} input.actions 操作の一覧
 * @param {string} input.matrixPrefix RBAC 行列テストの名前の接頭辞
 * @param {{ provider: string, model: string }[]} input.models 料金表のモデル一覧 (正本の JSON から導く)
 * @param {string} input.pricePrefix 料金テストの名前の接頭辞
 * @returns {string[]} 失敗の理由 (基準を満たしていれば空)
 */
export function evaluateStep2Report({
  testStatus,
  report,
  requiredPassedTests,
  roles,
  actions,
  matrixPrefix,
  models,
  pricePrefix,
}) {
  // Step1 の基準をそのまま引き継ぐ
  const failures = evaluateStep1Report({
    testStatus,
    report,
    requiredPassedTests,
    roles,
    actions,
    matrixPrefix,
  });
  // 料金表に 1 件もモデルが無ければ、照合が空振りしている (fail-closed)
  if (models.length === 0) failures.push('料金表からモデルを 1 件も読めません');
  // 料金表の全モデルに「誤差 0」のテストがあり pass していること
  const missing = missingPriceCases(report, { models, pricePrefix });
  if (missing.length > 0) failures.push(`料金計算のテストが不足/失敗: ${missing.join(', ')}`);
  // 判定結果
  return failures;
}
