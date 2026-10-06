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
// 識別子（モデル名・役割名）を続けられる文字。この文字が needle の直後にあるうちは、
// 「別の項目の名前の一部をたまたま拾っただけ」で、その項目のテストが有るとは言えない
const IDENTIFIER_CHARACTER = /[A-Za-z0-9._-]/;

/**
 * そのテスト名が、期待する項目の名前を**項目として**含んでいるか。
 *
 * **単なる `includes` では足りない** — 料金表には `openai gpt-5` と `openai gpt-5-mini` の
 * ように一方が他方の接頭辞になる綴りがあり、部分一致だけだと `gpt-5` のテストが 1 件も
 * 無くても `gpt-5-mini` のテストが代わりに当たってしまう（実測で、ゲートは緑のまま
 * `gpt-5` の「誤差 0」を一度も確かめずに通った。`gpt-4.1` と `gpt-4.1-mini` も同じ）。
 * そこで needle の**前後**が「識別子を続けられない文字」（空白・文末など）であることまで求める。
 *
 * **後ろだけでは足りない。** 一方が他方の**接尾辞**になる綴りも実在する — 連鎖の壊れ方には
 * `hash_mismatch` と `prev_hash_mismatch` があり、後ろだけを見る版では `hash_mismatch` の
 * テストが 1 件も無くても `prev_hash_mismatch` のテストが代わりに当たった（直後が空白なので
 * 境界を満たしてしまう）。接頭辞側と鏡像の穴なので、同じ 1 か所で両側を見る。
 * @param {string} name テストのフルネーム
 * @param {string} needle 期待する項目の名前
 * @returns {boolean} 項目として含んでいれば true
 */
function namesCase(name, needle) {
  // 出現位置をすべて見る（別の出現で境界を満たすことがある）
  for (let at = name.indexOf(needle); at >= 0; at = name.indexOf(needle, at + 1)) {
    // needle の直前の 1 文字（先頭なら undefined）
    const previous = name[at - 1];
    // needle の直後の 1 文字（文末なら undefined）
    const next = name[at + needle.length];
    // 前後どちらも「識別子の続き」でなければ、その項目を名指ししている
    const startsItem = previous === undefined || !IDENTIFIER_CHARACTER.test(previous);
    const endsItem = next === undefined || !IDENTIFIER_CHARACTER.test(next);
    if (startsItem && endsItem) return true;
  }
  // どの出現も別の項目の一部だった
  return false;
}

function missingPassedCases(report, expected, needlesOf, labelOf) {
  // 全テストの (フルネーム, 結果) を平坦化する
  const results = (report.testResults ?? []).flatMap((file) =>
    (file.assertionResults ?? []).map((test) => ({ name: test.fullName, status: test.status })),
  );
  // 見つからない・落ちている項目を集める
  const missing = [];
  // 期待する項目をすべて見る
  for (const item of expected) {
    // その項目に対応するテスト名の手がかり (**複数あれば全部を含むことを求める**)。
    // 1 本しか渡せない形だと、名前の中で離れている 2 つの手がかり — 改ざん検知の
    // 「接頭辞」と「壊れ方の綴り」のように — をまとめて要求できず、どちらか片方だけを
    // 見ることになる (接頭辞だけなら壊れ方の網羅が消え、綴りだけなら別の無関係なテストが当たる)
    const needles = needlesOf(item);
    // 名前にそれらすべてを含む pass したテストがあるか (**部分一致では終わらせない**。下記)
    const hit = results.find(
      (test) =>
        typeof test.name === 'string' &&
        needles.every((needle) => namesCase(test.name, needle)) &&
        test.status === 'passed',
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
    ({ role, action }) => [`${matrixPrefix}${role} × ${action}`],
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
    ({ provider, model }) => [`${pricePrefix}${provider} ${model}`],
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

/**
 * 除外理由のそれぞれについて、pass した「除外: <理由>」のテストが見つからないものを返す。
 * **期待するテスト名は除外理由の一覧 (正本の enum) から導く** — ここに書き写すと、
 * 理由を足した人がテストを書き忘れてもゲートは緑のままになる (料金表と同じ形)。
 * @param {{ testResults?: { assertionResults?: { fullName?: string, status?: string }[] }[] }} report vitest の JSON レポート
 * @param {{ reasons: string[], exclusionPrefix: string }} exclusion 除外理由の一覧とテスト名の接頭辞
 * @returns {string[]} 見つからなかった理由の配列 (すべて揃っていれば空)
 */
export function missingExclusionCases(report, { reasons, exclusionPrefix }) {
  // 「除外: <理由>」を含む pass したテストがあるか
  return missingPassedCases(
    report,
    reasons,
    (reason) => [`${exclusionPrefix}${reason}`],
    (reason) => reason,
  );
}

/**
 * Step3 の受け入れ基準のうち、テストレポートから判定できるぶんを見る。
 * Step2 までの基準 (件数・RBAC 行列・料金計算・失敗 0) は**引き継ぐ** — ゲートは常に最新 Step の
 * ものだけを回すので、ここで引き継がないと前の Step の基準が誰にも見られなくなる。
 * 再現率はテストではなくベンチ (scripts/bench-evaluation.ts) が測るので、ここでは扱わない。
 * @param {object} input 判定材料 (Step2 のものに除外理由の一覧を足したもの)
 * @param {number} input.testStatus `npm run test` の終了コード
 * @param {object} input.report vitest の JSON レポート
 * @param {number} input.requiredPassedTests pass したテストの下限
 * @param {string[]} input.roles 役割の一覧
 * @param {string[]} input.actions 操作の一覧
 * @param {string} input.matrixPrefix RBAC 行列テストの名前の接頭辞
 * @param {{ provider: string, model: string }[]} input.models 料金表のモデル一覧
 * @param {string} input.pricePrefix 料金テストの名前の接頭辞
 * @param {string[]} input.reasons 除外理由の一覧 (正本の enum から導く)
 * @param {string} input.exclusionPrefix 除外テストの名前の接頭辞
 * @returns {string[]} 失敗の理由 (基準を満たしていれば空)
 */
export function evaluateStep3Report({
  testStatus,
  report,
  requiredPassedTests,
  roles,
  actions,
  matrixPrefix,
  models,
  pricePrefix,
  reasons,
  exclusionPrefix,
}) {
  // Step2 までの基準をそのまま引き継ぐ
  const failures = evaluateStep2Report({
    testStatus,
    report,
    requiredPassedTests,
    roles,
    actions,
    matrixPrefix,
    models,
    pricePrefix,
  });
  // 除外理由を 1 件も読めなければ、照合が空振りしている (fail-closed)
  if (reasons.length === 0) failures.push('除外理由を 1 件も読めません');
  // 全種類の除外理由に、pass したテストがあること
  const missing = missingExclusionCases(report, { reasons, exclusionPrefix });
  if (missing.length > 0) failures.push(`不正出力の除外テストが不足/失敗: ${missing.join(', ')}`);
  // 判定結果
  return failures;
}

/**
 * ベンチ 1 本の実行結果 (終了コードと標準出力) を、受け入れ基準の観点で判定する。
 *
 * **ゲートが終了コードだけを見ていた穴を塞ぐ。** ベンチの中で受け入れ基準を強制していても、
 * 「何も出さずに exit 0」にできればゲートは緑だった (実測で 3 通りの書き方が全件緑で通った)。
 * 結果の JSON を読めば、静的解析が捉えられなかった形もまとめて落ちる。
 * **判定そのものはベンチ側 (`passed`) を信用せず、上限との比較もここで独立に行う** —
 * `passed` だけを見ると、`passed: true` を出すだけの変異が素通りする。
 * **独立に比べるのは受け入れ基準の上限 1 本だけ** — 計測が成立したかの門番 (2xx 以外の件数・
 * 最小件数・捨て玉) はベンチ側の `passed` を信じている。そちらの担保は
 * tests/gate-scripts.test.ts の negative control (素の Node で全基準を 1 本ずつ破る) が持つ。
 * **上限は呼び出し側 (受け入れ基準の正本 scripts/lib/step2-criteria.mjs) から受け取る** —
 * ベンチの出力から読むと比較の両辺が同じ信頼できない出力に由来し、独立な検証にならない。
 * 出力にも載っている上限は、正本と一致することまで確かめる (食い違いを落とす)。
 * @param {{ label: string, status: number, stdout: string, valueField?: string, limitField?: string, limit?: number }} input
 *   label = 期待するベンチのラベル / status = 終了コード / stdout = 標準出力 /
 *   valueField = 突き合わせる実測値の項目名 / limitField = 出力に載る上限の項目名 /
 *   limit = 正本の上限 (3 つ揃ったときだけ比較する)
 * @returns {string[]} 満たしていない基準の文言 (すべて満たしていれば空配列)
 */
export function benchOutputProblems({ label, status, stdout, valueField, limitField, limit }) {
  // 見つかった問題
  const failures = [];
  // 終了コードが 0 でなければ、理由はベンチ自身がエラー出力へ出している
  if (status !== 0) failures.push(`ベンチ ${label} が失敗しました (終了コード ${status})`);
  // **比較の材料が揃っていなければ落とす** (呼び出し側で 1 つ省くだけで比較が無音で消えないように)
  if (typeof valueField !== 'string' || typeof limitField !== 'string' || typeof limit !== 'number')
    failures.push(`ベンチ ${label} の検査に実測値・上限の指定がありません`);
  // 標準出力の行のうち、JSON のオブジェクトとして読めたものを集める
  const parsed = jsonObjectsInLines(stdout);
  // **そのベンチのラベルを名乗る行だけを結果の候補にする。**
  // 「読めた最後の行を採る」形だと、本物の失敗行のあとに嘘の合格行を 1 行足すだけで
  // 後勝ちして通り、逆に無関係な `{}` が 1 行混ざるだけで理由の読めない赤になった (実測)
  const candidates = parsed.filter((value) => value.bench === label);
  // 1 本も無ければ、計測せずに終わっているか別のベンチの結果を出している (fail-closed)
  if (candidates.length === 0) {
    failures.push(
      parsed.length === 0
        ? `ベンチ ${label} が結果の JSON を出していません`
        : `ベンチ ${label} の結果のラベルが ${JSON.stringify(parsed[parsed.length - 1].bench)} です`,
    );
    return failures;
  }
  // 2 本以上あるのは、嘘の結果を重ね書きしている形なので通さない
  if (candidates.length > 1) {
    failures.push(`ベンチ ${label} の結果の JSON が ${candidates.length} 本あります`);
    return failures;
  }
  // 唯一の結果
  const result = candidates[0];
  // ベンチ自身の判定
  if (result.passed !== true) failures.push(`ベンチ ${label} が受け入れ基準を満たしていません`);
  // 材料が揃っていなければここまで (理由は上で積んである)
  if (typeof valueField !== 'string' || typeof limitField !== 'string' || typeof limit !== 'number')
    return failures;
  // 実測した値
  const value = result[valueField];
  // 数値として読めなければ判定できない (黙って飛ばさない)
  if (typeof value !== 'number')
    failures.push(`ベンチ ${label} の結果に数値の ${valueField} がありません`);
  else if (value > limit)
    failures.push(`ベンチ ${label} の ${valueField} が上限を超えています (${value} > ${limit})`);
  // 出力に載っている上限が正本と食い違っていれば、どちらかが古い
  if (result[limitField] !== limit)
    failures.push(
      `ベンチ ${label} の ${limitField} が受け入れ基準と違います (${JSON.stringify(result[limitField])} ≠ ${limit})`,
    );
  // 判定結果
  return failures;
}

/**
 * ルールの種別それぞれについて、pass した「発火: <種別>」のテストが見つからないものを返す。
 * **期待するテスト名は種別の一覧 (正本の enum) から導く** — 一覧をここに書き写すと、種別を
 * 足した人がテストを書き忘れてもゲートは緑のままになる (料金表・除外理由と同じ形)。
 * @param {{ testResults?: { assertionResults?: { fullName?: string, status?: string }[] }[] }} report vitest の JSON レポート
 * @param {{ kinds: string[], firingPrefix: string }} firing 種別の一覧とテスト名の接頭辞
 * @returns {string[]} 見つからなかった種別の配列 (すべて揃っていれば空)
 */
export function missingFiringCases(report, { kinds, firingPrefix }) {
  // 「発火: <種別>」を含む pass したテストがあるか
  return missingPassedCases(
    report,
    kinds,
    (kind) => [`${firingPrefix}${kind}`],
    (kind) => kind,
  );
}

/**
 * 連鎖の壊れ方それぞれについて、pass した改ざん検知のテストが見つからないものを返す。
 *
 * **手がかりを 2 つ渡す**のがここだけの違い: テスト名は
 * 「改ざん検知: 値を書き換えた行は hash_mismatch で落ちる」のように、接頭辞と壊れ方の綴りが
 * 名前の中で離れている。接頭辞だけを見ると壊れ方の網羅が消え、綴りだけを見ると改ざんと
 * 関係のないテスト (壊れ方の名前に触れるだけのもの) が代わりに当たる。
 * @param {{ testResults?: { assertionResults?: { fullName?: string, status?: string }[] }[] }} report vitest の JSON レポート
 * @param {{ breaks: string[], tamperPrefix: string }} tamper 壊れ方の一覧とテスト名の接頭辞
 * @returns {string[]} 見つからなかった壊れ方の配列 (すべて揃っていれば空)
 */
export function missingTamperCases(report, { breaks, tamperPrefix }) {
  // 「改ざん検知: 」と壊れ方の綴りの**両方**を含む pass したテストがあるか
  return missingPassedCases(
    report,
    breaks,
    (reason) => [tamperPrefix, reason],
    (reason) => reason,
  );
}

/**
 * Step4 の受け入れ基準のうち、テストレポートから判定できるぶんを見る。
 * Step3 までの基準は**引き継ぐ** — ゲートは常に最新 Step のものだけを回すので、
 * ここで引き継がないと前の Step の基準が誰にも見られなくなる。
 * 発火から停止までの時間はテストではなくベンチ (scripts/bench-guardrail.ts) が測るので扱わない。
 * @param {object} input 判定材料 (Step3 のものに種別・壊れ方・E2E のテスト名を足したもの)
 * @param {number} input.testStatus `npm run test` の終了コード
 * @param {object} input.report vitest の JSON レポート
 * @param {number} input.requiredPassedTests pass したテストの下限
 * @param {string[]} input.roles 役割の一覧
 * @param {string[]} input.actions 操作の一覧
 * @param {string} input.matrixPrefix RBAC 行列テストの名前の接頭辞
 * @param {{ provider: string, model: string }[]} input.models 料金表のモデル一覧
 * @param {string} input.pricePrefix 料金テストの名前の接頭辞
 * @param {string[]} input.reasons 除外理由の一覧
 * @param {string} input.exclusionPrefix 除外テストの名前の接頭辞
 * @param {string[]} input.kinds ルールの種別の一覧 (正本の enum から導く)
 * @param {string} input.firingPrefix 発火テストの名前の接頭辞
 * @param {string[]} input.breaks 連鎖の壊れ方の一覧 (正本の定数から導く)
 * @param {string} input.tamperPrefix 改ざん検知テストの名前の接頭辞
 * @param {string} input.e2eTestName E2E テストの名前
 * @returns {string[]} 失敗の理由 (基準を満たしていれば空)
 */
export function evaluateStep4Report({
  testStatus,
  report,
  requiredPassedTests,
  roles,
  actions,
  matrixPrefix,
  models,
  pricePrefix,
  reasons,
  exclusionPrefix,
  kinds,
  firingPrefix,
  breaks,
  tamperPrefix,
  e2eTestName,
}) {
  // Step3 までの基準をそのまま引き継ぐ
  const failures = evaluateStep3Report({
    testStatus,
    report,
    requiredPassedTests,
    roles,
    actions,
    matrixPrefix,
    models,
    pricePrefix,
    reasons,
    exclusionPrefix,
  });
  // 種別を 1 件も読めなければ、照合が空振りしている (fail-closed)
  if (kinds.length === 0) failures.push('ルールの種別を 1 件も読めません');
  // 全種類の種別に、pass した発火テストがあること (受け入れ基準 1 の「発火」側)
  const missingFiring = missingFiringCases(report, { kinds, firingPrefix });
  if (missingFiring.length > 0)
    failures.push(`発火のテストが不足/失敗: ${missingFiring.join(', ')}`);
  // 壊れ方を 1 件も読めなければ、照合が空振りしている (fail-closed)
  if (breaks.length === 0) failures.push('連鎖の壊れ方を 1 件も読めません');
  // 全種類の壊れ方に、pass した改ざん検知テストがあること (受け入れ基準 2)
  const missingTamper = missingTamperCases(report, { breaks, tamperPrefix });
  if (missingTamper.length > 0)
    failures.push(`改ざん検知のテストが不足/失敗: ${missingTamper.join(', ')}`);
  // E2E が pass していること (受け入れ基準 3)。**名前を 1 本だけ探す** —
  // 「登録→実行→超過→停止→復帰」は 1 本のテストで順に通す約束なので、照合も 1 本で足りる
  const missingE2e = missingPassedCases(
    report,
    [e2eTestName],
    (name) => [name],
    (name) => name,
  );
  if (missingE2e.length > 0) failures.push(`E2E のテストが不足/失敗: ${missingE2e.join(', ')}`);
  // 判定結果
  return failures;
}

/**
 * 標準出力の**行ごと**に JSON のオブジェクトを探して集める。
 * 計測スクリプトは結果を 1 行の JSON で出す約束なので、行で割れば npm 自身の出力と混ざらない。
 * @param {string} stdout 捕まえた標準出力
 * @returns {Record<string, unknown>[]} 読めたオブジェクト (読めない行は捨てる)
 */
function jsonObjectsInLines(stdout) {
  // 読めたオブジェクト
  const parsed = [];
  for (const line of stdout.split('\n')) {
    // 空行や npm 自身の出力は飛ばす
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    // JSON として読めたものだけを覚える (読めない行は結果ではない)
    try {
      const value = JSON.parse(trimmed);
      if (typeof value === 'object' && value !== null) parsed.push(value);
    } catch {
      // 結果ではない行なので無視する (理由を残す必要は無い)
      continue;
    }
  }
  return parsed;
}

/**
 * Playwright の JSON レポートから、入れ子の suite を辿って spec (テスト 1 本) を平坦に集める。
 * **入れ子を辿らないと 1 本も見つからない** — レポートはファイル → describe → spec の 3 段。
 * @param {{ suites?: unknown[] }} report Playwright の JSON レポート
 * @returns {{ title: string, ok: boolean }[]} spec の名前と成否
 */
/**
 * その spec が**実際に通った**かを返す。
 *
 * **`spec.ok` を信じてはいけない。** Playwright の JSON レポータが書く `ok` は
 * `TestCase.ok()` の値で、`skipped` でも `true` になる（`expected` / `flaky` / `skipped` が
 * すべて真）。そのため `ok` だけを見ると、画面 1 つに `test.skip()` を足すだけで
 * 「その画面は一度も動いていないのにゲートは 5 画面すべて pass」になる — 検出網が自分で
 * 塞いだつもりの「画面 1 つ分のテストを消す形」の、より静かな版（テストの本数も減らない）。
 *
 * そこで **1 本以上走っていて、すべてが `expected` であること**を求める。`flaky` を通さないのは、
 * このスイートが状態を書き換える直列の 1 本で、再試行は意味を持たないため（`playwright.config.ts`）。
 */
function specPassed(spec) {
  // 実行の記録が配列でなければ走っていない
  if (!Array.isArray(spec.tests) || spec.tests.length === 0) return false;
  // 1 本でも「期待どおり通った」以外があれば通っていない扱いにする
  return spec.tests.every((test) => test?.status === 'expected');
}

function playwrightSpecs(report) {
  // 集めた spec
  const specs = [];
  // 幅優先で辿る (再帰を使わないのは、深さの上限を気にしないため)
  const queue = Array.isArray(report.suites) ? [...report.suites] : [];
  while (queue.length > 0) {
    // 次の suite
    const suite = queue.shift();
    // オブジェクトでなければ飛ばす
    if (typeof suite !== 'object' || suite === null) continue;
    // その suite が持つ spec
    for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
      // 名前と成否が読めるものだけを集める
      if (typeof spec?.title === 'string') specs.push({ title: spec.title, ok: specPassed(spec) });
    }
    // 子の suite を積む
    for (const child of Array.isArray(suite.suites) ? suite.suites : []) queue.push(child);
  }
  return specs;
}

/**
 * E2E (Playwright) の実行結果を、受け入れ基準「主要 5 画面の E2E 全 pass」の観点で判定する。
 *
 * **期待する画面は正本の一覧から受け取る** (`scripts/lib/step5-criteria.mjs`)。一覧をここへ
 * 書き写すと、画面を足した人がテストを書き忘れてもゲートは緑のままになる (料金表と同じ形)。
 * **終了コードだけを見ない** — スイートを空にして exit 0 にする形も、画面 1 つ分の
 * テストを消す形も、終了コードには現れない。
 * @param {{ status: number, stdout: string, screens: { title: string }[], screenPrefix: string }} input
 * @returns {string[]} 満たしていない基準の文言 (すべて満たしていれば空配列)
 */
export function e2eOutputProblems({ status, stdout, screens, screenPrefix }) {
  // 見つかった問題
  const failures = [];
  // 終了コードが 0 でなければ、理由は Playwright 自身が出している
  if (status !== 0) failures.push(`E2E が失敗しました (終了コード ${status})`);
  // 期待する画面が無ければ照合が空振りしている (fail-closed)
  if (!Array.isArray(screens) || screens.length === 0) {
    failures.push('E2E の対象画面を 1 つも読めません');
    return failures;
  }
  // 接頭辞が無ければテスト名を組み立てられない (fail-closed)
  if (typeof screenPrefix !== 'string') {
    failures.push('E2E のテスト名の接頭辞がありません');
    return failures;
  }
  // **レポートは複数行の JSON なので、最初の { から最後の } までをまとめて読む**
  // (ベンチのように 1 行ではない。npm の前置きが混ざっても落とせる)
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  // 読めなければ、テストを 1 本も走らせずに終わっている (fail-closed)
  if (start < 0 || end <= start) {
    failures.push('E2E の JSON レポートを読めません');
    return failures;
  }
  // レポートを読む
  let report;
  try {
    report = JSON.parse(stdout.slice(start, end + 1));
  } catch (error) {
    // 読めない理由を残す (§6 握り潰さない)
    failures.push(
      `E2E の JSON レポートを解釈できません: ${error instanceof Error ? error.message : error}`,
    );
    return failures;
  }
  // spec を平坦に集める
  const specs = playwrightSpecs(report);
  // 1 本も無ければ走っていない (fail-closed。「対象ゼロ＝緑」にしない)
  if (specs.length === 0) {
    failures.push('E2E のテストが 1 本も走っていません');
    return failures;
  }
  // pass した spec の名前
  const passed = new Set(specs.filter((spec) => spec.ok).map((spec) => spec.title));
  // 画面ごとに「その名前の spec が pass しているか」を見る
  const missing = screens
    .map((screen) => `${screenPrefix}${screen.title}`)
    .filter((name) => !passed.has(name));
  // 足りなければ画面の名前を挙げて落とす
  if (missing.length > 0) failures.push(`E2E が不足/失敗している画面: ${missing.join(', ')}`);
  // 判定結果
  return failures;
}

/**
 * Lighthouse の計測結果を、受け入れ基準「Performance / Accessibility ≧ 90」の観点で判定する。
 *
 * **合否は計測スクリプト側に持たせない** (ベンチと違って `passed` を出させない) — 測る側と
 * 判定する側を分けておけば、「測れていないのに合格」を測る側だけでは作れない。
 * **上限・カテゴリ・計測回数は受け入れ基準の正本から受け取り、出力に載っている値と一致することまで確かめる**
 * (食い違いはどちらかが古い)。
 * @param {{ status: number, stdout: string, screens: { key: string }[], categories: string[], minScore: number, runs: number }} input
 * @returns {string[]} 満たしていない基準の文言 (すべて満たしていれば空配列)
 */
export function lighthouseOutputProblems({ status, stdout, screens, categories, minScore, runs }) {
  // 見つかった問題
  const failures = [];
  // 終了コードが 0 でなければ、理由は計測スクリプトが出している
  if (status !== 0) failures.push(`Lighthouse の計測が失敗しました (終了コード ${status})`);
  // 材料が揃っていなければ落とす (呼び出し側で 1 つ省くだけで比較が無音で消えないように)。
  // **終了コードの失敗とは別に数える** — 同じ配列へ混ぜて `failures.length > 0 && status === 0`
  // で返していた版は、計測が非 0 で終わったときに材料不足の枝を素通りし、`categories.filter`
  // が `undefined` を触って TypeError になっていた（判定の文言が 1 つも返らず、呼び出し側の
  // `exitIfFailures` は理由を出す機会すら失う。実測）
  const missingMaterials = [];
  if (!Array.isArray(screens) || screens.length === 0)
    missingMaterials.push('Lighthouse の対象画面を 1 つも読めません');
  if (!Array.isArray(categories) || categories.length === 0)
    missingMaterials.push('Lighthouse の対象カテゴリを 1 つも読めません');
  if (typeof minScore !== 'number') missingMaterials.push('Lighthouse の合格点がありません');
  if (typeof runs !== 'number') missingMaterials.push('Lighthouse の計測回数がありません');
  // 1 つでも欠けていれば比較できないので、終了コードの成否に関わらずここで返す
  if (missingMaterials.length > 0) return [...failures, ...missingMaterials];
  // 結果の 1 行を探す (ベンチと同じ読み方を共有する)
  const candidates = jsonObjectsInLines(stdout).filter((value) => value.measure === 'lighthouse');
  // 無ければ測っていない (fail-closed)
  if (candidates.length === 0) {
    failures.push('Lighthouse の結果の JSON を読めません');
    return failures;
  }
  // 2 本以上あるのは、嘘の結果を重ね書きしている形なので通さない
  if (candidates.length > 1) {
    failures.push(`Lighthouse の結果の JSON が ${candidates.length} 本あります`);
    return failures;
  }
  // 唯一の結果
  const result = candidates[0];
  // 出力に載っている合格点が正本と食い違っていれば、どちらかが古い
  if (result.minScore !== minScore)
    failures.push(
      `Lighthouse の minScore が受け入れ基準と違います (${JSON.stringify(result.minScore)} ≠ ${minScore})`,
    );
  // 計測回数も同じく突き合わせる (1 回に減らす変更は数字の揺れをそのまま判定に持ち込む)
  if (result.runs !== runs)
    failures.push(
      `Lighthouse の計測回数が受け入れ基準と違います (${JSON.stringify(result.runs)} ≠ ${runs})`,
    );
  // 見たカテゴリが期待と一致すること (片方だけ測って緑にできないように)
  const measured = Array.isArray(result.categories) ? result.categories : [];
  const missingCategories = categories.filter((category) => !measured.includes(category));
  if (missingCategories.length > 0)
    failures.push(`Lighthouse が測っていないカテゴリ: ${missingCategories.join(', ')}`);
  // 画面ごとの点数
  const pages = Array.isArray(result.pages) ? result.pages : [];
  for (const screen of screens) {
    // その画面の結果
    const page = pages.find((entry) => entry?.page === screen.key);
    // 無ければその画面を測っていない
    if (page === undefined) {
      failures.push(`Lighthouse が ${screen.key} を測っていません`);
      continue;
    }
    // カテゴリごとに合格点と比べる
    for (const category of categories) {
      // 点数 (数値でなければ測れていない)
      const score = page.scores?.[category];
      if (typeof score !== 'number') {
        failures.push(`Lighthouse の ${screen.key} に数値の ${category} がありません`);
        continue;
      }
      // 合格点を下回っていれば落とす
      if (score < minScore)
        failures.push(`Lighthouse の ${screen.key} の ${category} が ${score} 点 (< ${minScore})`);
    }
  }
  // 判定結果
  return failures;
}

/**
 * Step5 の受け入れ基準のうち**テストレポートで見る分**を判定する。
 * Step4 までをそのまま引き継ぎ、「表示データと DB 集計の突合テストが pass しているか」を足す。
 *
 * E2E と Lighthouse は別の実行なので、`e2eOutputProblems` / `lighthouseOutputProblems` が見る。
 * @param {Parameters<typeof evaluateStep4Report>[0] & { reconcileTestName: string }} input
 * @returns {string[]} 満たしていない基準の文言 (すべて満たしていれば空配列)
 */
/**
 * 名前に手がかりを含むテストの群を見る（件数の下限 ＋ 全部 pass）。
 *
 * **「流れたものから期待を導く」形になっていることに注意して使う。** 群の件数だけを見ると、
 * テストを 1 本消す変異は要求も一緒に縮むので素通りする（この repo が繰り返し避けている形）。
 * だから呼び出し側は**群とは別の手がかり**（導出と表を突き合わせるテストの名前）も必ず要求する。
 * ここが見るのは「下限を満たしていること」と「群の中に落ちているものが無いこと」だけ。
 *
 * @param {{ testResults?: { assertionResults?: { fullName?: string, status?: string }[] }[] }} report vitest の JSON レポート
 * @param {{ prefix: string, minCount: number, label: string }} expectation 手がかり・下限・表示名
 * @returns {string[]} 満たしていない基準の一覧（満たしていれば空）
 */
export function prefixedGroupProblems(report, { prefix, minCount, label }) {
  // 満たしていない基準
  const failures = [];
  // 手がかりが無ければ照合できない（fail-closed）
  if (typeof prefix !== 'string' || prefix.length === 0) {
    failures.push(`${label} のテスト名の手がかりがありません`);
    return failures;
  }
  // 下限が正の整数でなければ判定にならない（0 を許すと「1 本も無くても緑」になる）
  if (!Number.isInteger(minCount) || minCount <= 0) {
    failures.push(`${label} の最小件数が正の整数ではありません`);
    return failures;
  }
  // 全テストの (フルネーム, 結果) を平坦化する
  const results = (report?.testResults ?? []).flatMap((file) =>
    (file.assertionResults ?? []).map((test) => ({ name: test.fullName, status: test.status })),
  );
  // 手がかりを含むテスト
  const group = results.filter(
    (test) => typeof test.name === 'string' && test.name.includes(prefix),
  );
  // 件数の下限
  if (group.length < minCount) {
    failures.push(
      `${label} のテストが ${group.length} 件しかありません (必要: ${minCount} 件以上)`,
    );
  }
  // 落ちているものを名指しする
  const failed = group.filter((test) => test.status !== 'passed').map((test) => test.name);
  if (failed.length > 0) failures.push(`${label} のテストが失敗: ${failed.join(', ')}`);
  // 判定結果
  return failures;
}

/**
 * カバレッジの 4 指標がすべて下限以上であること。
 *
 * **4 指標すべてに掛ける** — 1 つだけ（lines など）を見る形にすると、通る指標を選んで
 * 基準を満たしたように見せられる。測る範囲の正本は `scripts/lib/step6-criteria.mjs`。
 *
 * @param {unknown} summary `coverage/coverage-summary.json` を解析した値
 * @param {number} minPercent 下限（%）
 * @returns {string[]} 満たしていない基準の一覧（満たしていれば空）
 */
export function coverageProblems(summary, minPercent) {
  // 満たしていない基準
  const failures = [];
  // 下限が数値でなければ判定にならない（fail-closed）
  if (typeof minPercent !== 'number' || !Number.isFinite(minPercent) || minPercent <= 0) {
    failures.push('カバレッジの下限が正の数ではありません');
    return failures;
  }
  // 合計が読めること
  const total = summary && typeof summary === 'object' ? summary.total : undefined;
  if (total === null || typeof total !== 'object') {
    failures.push('カバレッジの合計を読めません');
    return failures;
  }
  // 見る指標（4 つすべて。1 つでも読めなければ落とす）
  for (const metric of ['statements', 'branches', 'functions', 'lines']) {
    // その指標の％
    const pct = total[metric]?.pct;
    // 読めなければ落とす（「読めないから緑」にしない）
    if (typeof pct !== 'number' || !Number.isFinite(pct)) {
      failures.push(`カバレッジの ${metric} を読めません`);
      continue;
    }
    // 下限を満たしていること
    if (pct < minPercent) {
      failures.push(`カバレッジの ${metric} が ${pct}% (必要: ${minPercent}% 以上)`);
    }
  }
  // 判定結果
  return failures;
}

/**
 * Step6 の受け入れ基準の判定（Step5 までを引き継ぎ、3 つを足す）。
 *
 * 1. **越境アクセス**: 契約と表を突き合わせる導出のテストが pass し、`越境: ` の群が全部 pass
 *    （導出のテストを別に要求するのが要点 — 群だけを見ると、表から 1 件消す変異が素通りする）
 * 2. **Webhook の冪等性**: `冪等性: ` の群が下限以上あって全部 pass
 * 3. **カバレッジ**: 4 指標すべてが下限以上
 *
 * @param {object} input 判定に要る材料
 * @returns {string[]} 満たしていない基準の一覧（満たしていれば空）
 */
export function evaluateStep6Report({
  crossTenantDerivationTestName,
  crossTenantPrefix,
  crossTenantMinCount,
  idempotencyPrefix,
  idempotencyMinCount,
  coverageSummary,
  coverageMinPercent,
  ...step5
}) {
  // Step5 までの基準をそのまま引き継ぐ
  const failures = evaluateStep5Report(step5);
  // 1-a. 導出と表を突き合わせるテストが pass していること（**群とは別の手がかり**）
  if (
    typeof crossTenantDerivationTestName !== 'string' ||
    crossTenantDerivationTestName.length === 0
  ) {
    failures.push('越境テストの導出を確かめるテストの名前がありません');
  } else {
    const missing = missingPassedCases(
      step5.report,
      [crossTenantDerivationTestName],
      (name) => [name],
      (name) => name,
    );
    if (missing.length > 0) {
      failures.push(`越境テストの導出の照合が不足/失敗: ${missing.join(', ')}`);
    }
  }
  // 1-b. 越境の群が全部 pass していること
  failures.push(
    ...prefixedGroupProblems(step5.report, {
      prefix: crossTenantPrefix,
      minCount: crossTenantMinCount,
      label: '越境アクセス',
    }),
  );
  // 2. 冪等性の群
  failures.push(
    ...prefixedGroupProblems(step5.report, {
      prefix: idempotencyPrefix,
      minCount: idempotencyMinCount,
      label: 'Webhook の冪等性',
    }),
  );
  // 3. カバレッジ
  failures.push(...coverageProblems(coverageSummary, coverageMinPercent));
  // 判定結果
  return failures;
}

export function evaluateStep5Report({ reconcileTestName, ...step4 }) {
  // Step4 までの基準をそのまま引き継ぐ
  const failures = evaluateStep4Report(step4);
  // 突合テストの名前が無ければ照合できない (fail-closed)
  if (typeof reconcileTestName !== 'string' || reconcileTestName.length === 0) {
    failures.push('突合テストの名前がありません');
    return failures;
  }
  // そのテストが pass していること (受け入れ基準 3)。
  // **名前を 1 本だけ探す** — 突合は 1 本のテストで「画面の集計 = DB の集計」を見る約束
  const missing = missingPassedCases(
    step4.report,
    [reconcileTestName],
    (name) => [name],
    (name) => name,
  );
  if (missing.length > 0) failures.push(`突合テストが不足/失敗: ${missing.join(', ')}`);
  // 判定結果
  return failures;
}
