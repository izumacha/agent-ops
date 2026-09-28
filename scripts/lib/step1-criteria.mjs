// Step1 の受け入れ基準の値 (docs/roadmap.md の Step1 行が正本)。
// **後の Step のゲートもここを読む** — ゲートは「実装済みの最新 Step のもの」しか回さないので
// (docs/roadmap.md のゲート運用ルール 2)、引き継がないと Step1 の基準が誰にも見られなくなる。
// 値をゲートごとに書き写すと、新しいゲートで静かに緩められる (tests/docs-gate.test.ts が
// 「ゲート本体に数値を書かない」ことも含めて見張る)

// 受け入れ基準: pass したテストの件数の下限
export const REQUIRED_PASSED_TESTS = 60;

// 受け入れ基準: 権限違反テストの全パターン (役割 3 × 操作 3)。役割と操作の一覧そのものは
// src/domain/rbac.ts が正本で、tests/rbac.test.ts が enum との網羅を固定する。
// ここは基準の文言どおり 3 × 3 を数えるための写しで、許可表との一致は tests/docs-gate.test.ts が見る
export const ROLES = ['viewer', 'operator', 'admin'];
export const ACTIONS = ['view', 'execute', 'stop'];

// RBAC 行列テストの名前の接頭辞 (tests/api/rbac-matrix.test.ts と一致させる)
export const MATRIX_TEST_PREFIX = 'RBAC 行列: ';
