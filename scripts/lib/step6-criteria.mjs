// Step6 の受け入れ基準の値（`docs/roadmap.md` の Step6 行と `tests/docs-gate.test.ts` が突き合わせる）。
// **ゲート本体に数値を書かない** — 後の Step のゲートが同じ定義を読むため、そして
// ゲートに数値を書けるようにすると新しい Step で静かに緩められるため（ADR-0004）。

/**
 * ロジック層のカバレッジの下限（%）。
 *
 * **測る対象をロジック層に限る**（下の `COVERAGE_INCLUDE`）。画面の `.tsx` は E2E 5 画面と
 * Lighthouse が担保しているので、同じものを 2 つの指標で数えない — 入れると「画面の行数で
 * 全体の％が決まる」状態になり、ロジックのカバレッジが下がっても総計が動かない
 * （基準の解釈を決める判断なので `docs/roadmap.md` と ADR-0012 に書いてある）。
 */
export const COVERAGE_MIN_PERCENT = 80;

/**
 * カバレッジを測る対象（`vitest.config.mts` の `coverage.include` が読む）。
 *
 * ロジック層の 4 つ: ドメイン（純粋）・横断インフラ・データ層・API ルート。
 */
export const COVERAGE_INCLUDE = [
  'src/domain/**/*.ts',
  'src/lib/**/*.ts',
  'src/data/**/*.ts',
  'src/app/api/**/*.ts',
];

/**
 * 対象から外すもの（`vitest.config.mts` の `coverage.exclude` が読む）。
 *
 * **ここに増える差分は理由の妥当性をレビューで必ず確認する**（除外表はこのリポジトリが
 * 繰り返し「静かに緩む口」として見てきた形）。
 */
export const COVERAGE_EXCLUDE = [
  // 生成物（OpenAPI の型・Prisma クライアント）。コミットしないので測る意味が無い
  'src/generated/**',
  // 型だけのファイル（実行されるコードが 1 行も無い）
  'src/types/**',
  // Port の契約（型と定数だけ。実装は adapters 側で測る）
  'src/data/ports/**',
  // **実 DB が無いと 1 行も通らない結線とアダプタ。**
  // この計測は `npm run test`（DB 不要）の経路で走るので、prisma の結線と本番アダプタは
  // 原理的に 0% になる。含めると「測れないものを 0% として数える」ことになり、総計が
  // ロジック層の実態を表さなくなる（実測で functions が 78.5%、除くと 82% 台）。
  // **これらの正しさは受け入れ基準③（契約テストが CI で緑）が担保する** — 同じ対象を
  // 2 つの指標で数えないのは、画面を除いているのと同じ理由。
  'src/lib/prisma.ts',
  'src/lib/prisma-client.ts',
  'src/data/adapters/prisma/**',
];

/** 越境アクセスのテスト名の接頭辞（`tests/api/tenant-isolation.test.ts` が付ける） */
export const CROSS_TENANT_TEST_PREFIX = '越境: ';

/**
 * 越境テストの**導出と表を突き合わせる**テストの名前。
 *
 * **ゲートは群（接頭辞）とは別にこれを要求する。** 群の件数だけを見ると、表から 1 件消す変異は
 * 要求も一緒に縮むので素通りする（「流れたものから期待を導く」形。この repo が繰り返し
 * 避けている）。このテストが契約（openapi.yaml）と表を双方向で照合するので、
 * 「契約にあるのに表に無い」も「表にあるのに契約に無い」も落ちる。
 */
export const CROSS_TENANT_DERIVATION_TEST_NAME =
  '導出した対象と表が一致する（追記漏れ・古い登録のどちらでも落ちる）';

/**
 * 越境テストに要求する最小件数（**床**）。
 *
 * 正確な網羅は上の導出のテストが担保するので、ここは「群がまるごと消えたら気付く」ための床。
 * 現在の契約から導かれるのは 17 パターン。**下げない**（上げるのはルートが増えたとき）。
 */
export const CROSS_TENANT_MIN_CASES = 17;

/** Webhook の冪等性のテスト名の接頭辞（`tests/api/billing.test.ts` が付ける） */
export const IDEMPOTENCY_TEST_PREFIX = '冪等性: ';

/** 冪等性のテストに要求する最小件数（再送・同時・別 ID・弾いた要求の 4 系統） */
export const IDEMPOTENCY_MIN_CASES = 4;
