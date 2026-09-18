// gate:step1 の「受け入れ基準を満たしているか」の判定だけを取り出した純粋関数群。
//
// スクリプト本体に判定を書き下すと、値 (件数の下限) も判定そのものも黙って外せてしまう
// — 実測では `REQUIRED_PASSED_TESTS` を小さくしても、`if (...)` を `if (false && ...)` にしても
// ゲートは緑のまま通り、テスト件数も変わらなかった。ここへ出せば挙動をユニットテストで固定できる
// (tests/gate-scripts.test.ts)。**残る境界**: 「この関数を呼ばない」形に書き換える変異は署名からは
// 見分けられないので、そこは規約とレビューで守る。

/**
 * RBAC 行列 (役割 × 操作) のうち、pass したテストが見つからない組を返す。
 * @param {{ testResults?: { assertionResults?: { fullName?: string, status?: string }[] }[] }} report vitest の JSON レポート
 * @param {{ roles: string[], actions: string[], matrixPrefix: string }} matrix 期待する組み合わせ
 * @returns {string[]} 「役割 × 操作」の文字列の配列 (すべて揃っていれば空)
 */
export function missingMatrixCases(report, { roles, actions, matrixPrefix }) {
  // 全テストの (フルネーム, 結果) を平坦化する
  const results = (report.testResults ?? []).flatMap((file) =>
    (file.assertionResults ?? []).map((test) => ({ name: test.fullName, status: test.status })),
  );
  // 見つからない・落ちている組を集める
  const missing = [];
  // 役割 × 操作をすべて見る
  for (const role of roles) {
    for (const action of actions) {
      // 名前に「RBAC 行列: <役割> × <操作>」を含む pass したテストがあるか
      const needle = `${matrixPrefix}${role} × ${action}`;
      const hit = results.find(
        (test) =>
          typeof test.name === 'string' && test.name.includes(needle) && test.status === 'passed',
      );
      // 無ければ不足として記録する
      if (!hit) missing.push(`${role} × ${action}`);
    }
  }
  // 不足の一覧
  return missing;
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
