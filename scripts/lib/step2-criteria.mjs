// Step2 の受け入れ基準のしきい値 (docs/roadmap.md の Step2 行が正本)。
// ベンチ (scripts/bench-*.ts)・ゲート (scripts/gate-step2.mjs)・ロードマップとの突き合わせ
// (tests/docs-gate.test.ts) がここを読む。数値を 3 か所に書き写すと、必ずどれかが古くなる

// 料金計算のテスト名の接頭辞。tests/pricing.test.ts がこの接頭辞でテストを作り、
// ゲートは「料金表の全モデル分が pass しているか」をこの名前で照合する
export const PRICE_TEST_PREFIX = '料金: ';

// プロキシ経由で許される「追加遅延」の上限 (ミリ秒、p95)。
// 追加遅延 = プロキシ経由の p95 − 上流を直接叩いたときの p95
export const PROXY_ADDED_LATENCY_P95_MAX_MS = 50;

// 集計のベンチで投入する利用イベントの件数
export const USAGE_AGGREGATE_ROW_COUNT = 10_000;

// その件数に対する日次集計 1 回の上限 (ミリ秒)
export const USAGE_AGGREGATE_MAX_MS = 1_000;
