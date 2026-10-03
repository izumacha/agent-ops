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
