// README の quickstart が**デモシードのまま動く**ことを機械で確かめる。
//
// **なぜ要るか.** Step6 でプラン別の機能ゲートが入った時点で、README の手順のうち
// `GET /audit-logs/verify` は「デモテナントのプランが `auditChainVerify` を許すか」に依存する
// ようになった。ところが seed が `free` を作っていたので、クローンして手順どおりに叩くと
// **403 が返る**（README 自身が別の節で「`free` では 403 になる」と書いているので、文書の中で
// 矛盾していた）。lint も typecheck も全テストも緑のまま通り、気付けるのは人が手で叩いたときだけ。
//
// **手がかりを 2 つに分ける.** 「どのパスがプランで閉じているか」は**ルートの印から**
// （`ROUTE_REQUIRED_PLAN_FEATURE_BRAND`。表を手で書くと、ゲートを足した人が README を見ない）、
// 「quickstart が何を叩くか」は**README の本文から**読む。片方だけを基準にすると、
// 導出が狭まったときに検査も一緒に狭まって「対象ゼロ＝緑」で無力化される。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findRouteFiles } from './lib/route-files';
import { ROUTE_REQUIRED_PLAN_FEATURE_BRAND } from '@/lib/api/handler';
import { PLAN_FEATURES, type PlanFeature, planAllows } from '@/domain/plan';
import { DEMO_TENANT_PLAN } from '../prisma/seed-data';

// Route Handler を置いているディレクトリ
const APP_DIR = join(process.cwd(), 'src', 'app');
// README（quickstart の正本）
const README = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
// OpenAPI の `servers.url` と同じ接頭辞（ルートのファイル位置から URL を組むのに使う）
const API_PREFIX = '/api/v1';

/**
 * ルートのファイルパスを URL のパスへ直す（`src/app/api/v1/x/y/route.ts` → `/api/v1/x/y`）。
 *
 * 動的セグメント（`[id]`）を含むものは `null`（quickstart は `<...>` の穴埋めで書くので、
 * 文字列として突き合わせられない）。
 */
function urlPathOf(full: string): string | null {
  // `src/app` から見た相対パス
  const rel = relative(APP_DIR, full);
  // 末尾の `route.ts` を落としてセグメントに割る
  const segments = rel.split(sep).slice(0, -1);
  // 動的セグメントや Route Group を含むものは対象外
  if (segments.some((segment) => segment.startsWith('[') || segment.startsWith('('))) return null;
  // 先頭に `/` を付けて URL のパスにする
  return `/${segments.join('/')}`;
}

describe('README の quickstart とデモシードの整合', () => {
  // **プランで閉じているパスのうち、README の quickstart に出てくるものは
  // デモテナントのプランで通ること。**
  it('quickstart が叩くプラン限定の経路はデモのプランで使える', async () => {
    // 走査したルートの数（fail-closed の判定に使う）
    let scanned = 0;
    // README に出てきた「プラン限定のパス」（パス → 要る機能）
    const documented = new Map<string, PlanFeature>();
    // ルートを 1 つずつ読む（綴りではなく実際の export の印を見る）
    for (const full of findRouteFiles(APP_DIR)) {
      // URL のパスへ直せないもの（動的セグメント）は飛ばす
      const path = urlPathOf(full);
      if (path === null || !path.startsWith(API_PREFIX)) continue;
      scanned += 1;
      // モジュールを読み込む
      const routeModule: Record<string, unknown> = await import(pathToFileURL(full).href);
      // HTTP メソッドの export を順に見る
      for (const exported of Object.values(routeModule)) {
        // 機能ゲートの印を読む（宣言が無ければ undefined）
        const feature = (exported as Record<symbol, unknown> | null)?.[
          ROUTE_REQUIRED_PLAN_FEATURE_BRAND
        ];
        // 宣言が無いルートは誰でも叩けるので対象外。**表にある機能名であることまで確かめる** —
        // 綴り違いの宣言は `planAllows` が常に false を返すので「誰も使えない」側へ倒れる
        if (typeof feature !== 'string') continue;
        expect(PLAN_FEATURES, `${path} の宣言 ${feature} が表に無い`).toContain(feature);
        // README の本文にそのパスが出ていれば、quickstart が叩く経路として数える
        if (README.includes(path)) documented.set(path, feature as PlanFeature);
      }
    }
    // 走査そのものが壊れていないこと（対象ゼロ＝緑にしない）
    expect(scanned, 'URL へ直せた API ルートが 0 件').toBeGreaterThan(0);
    // **README がプラン限定の経路を 1 つも書いていない状態では、この検査は何も見ていない**
    expect(documented.size, 'README に出てくるプラン限定の経路が 0 件').toBeGreaterThan(0);
    // 書いてある経路はすべてデモのプランで通ること
    for (const [path, feature] of documented) {
      expect(
        planAllows(DEMO_TENANT_PLAN, feature),
        `README が ${path} を手順に書いているが、デモのプラン（${DEMO_TENANT_PLAN}）では ` +
          `${feature} が使えないので 403 になる。seed のプランを上げるか README を直す`,
      ).toBe(true);
    }
  });

  // **README が例示する `GET /billing` の応答はデモのプランと一致すること。**
  // プラン名だけを見る（上限の数値は `tests/docs-gate.test.ts` が `PLAN_LIMITS` と突き合わせる）
  it('GET /billing の出力例のプランがデモのプランと一致する', () => {
    // 例示の中の `"plan": "..."` を拾う
    const shown = [...README.matchAll(/"plan":\s*"([a-z]+)"/g)].map((match) => match[1]);
    // 1 つも無ければ README から例が消えている（検査が空回りする）
    expect(shown.length, 'README に `"plan": "..."` の例が無い').toBeGreaterThan(0);
    // すべてデモのプランと一致すること
    for (const plan of shown) {
      expect(plan, 'README の出力例のプランがデモシードと違う').toBe(DEMO_TENANT_PLAN);
    }
  });
});
