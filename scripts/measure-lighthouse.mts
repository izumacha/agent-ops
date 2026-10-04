// Step5 の受け入れ基準「Lighthouse Performance / Accessibility ≧ 90」を実測するスクリプト。
//   DATABASE_URL='postgresql://…/agent_ops_step5_contract?schema=app' npm run lighthouse
//
// **開発 DB では走らない** — 仕込みで全テーブルを TRUNCATE するので、契約テストやベンチと同じ
// 「専用 DB の名前（末尾 `_contract`）」の判定を通らなければ 1 行も書かずに落ちる（fail-closed）。
//
// **測る相手は本番ビルド**（`.next/standalone/server.js`）。dev サーバーは毎回その場で変換するので
// Performance が実態より悪く出る（基準を測る相手として正しくない）。先に `npm run build` が要る。
//
// **判定はここに書かない。** 測った点数と、受け入れ基準の上限を 1 行の JSON で標準出力へ出し、
// 合否は `scripts/gate-step5.mjs` が判定する（ベンチと同じ分担。判定を測る側に持たせると、
// 「測れていないのに合格」を測る側だけで作れてしまう）。
//
// **実際の Anthropic / OpenAI は呼ばない**（画面は上流を呼ばない。アプリへ渡す鍵も空にしている）。
//
// **拡張子が `.mts` なのは ESM として実行する必要があるため。** `.ts` だと tsx が CJS へ変換し、
// ESM 専用の lighthouse を取り込んだ時点で `__name is not defined` で落ちる（実測）。
import 'dotenv/config';
import lighthouse from 'lighthouse';
// **デスクトップの計測条件は Lighthouse 公式のプリセットを使う**（回線・CPU の絞り込みの数値を
// 自分で並べない。並べると測定の前提が写しになって古くなる）
import desktopConfig from 'lighthouse/core/config/desktop-config.js';
import { chromium } from '@playwright/test';
import {
  LIGHTHOUSE_CATEGORIES,
  LIGHTHOUSE_MIN_SCORE,
  LIGHTHOUSE_RUNS,
  STEP5_SCREENS,
  screenPath,
} from './lib/step5-criteria.mjs';
import { chromiumExecutablePath } from '../e2e/lib/chromium';
import { freePorts, startApp, stopApp } from '../e2e/lib/app';
import { seedE2eFixture } from '../e2e/lib/fixture';
import { SESSION_COOKIE_NAME } from '../src/lib/session';

// Lighthouse が返す点数は 0〜1。基準は 100 点満点なので揃える倍率
const SCORE_SCALE = 100;

/** 1 ページ分の点数（カテゴリ名 → 0〜100 の点数）。 */
type Scores = Record<string, number>;

/** 1 回だけ測る。認証が要る画面にはセッション Cookie をヘッダで渡す。 */
async function measureOnce(url: string, port: number, cookie: string | null): Promise<Scores> {
  // Lighthouse を 1 回走らせる（カテゴリは基準が見る 2 つだけに絞って時間を短くする）。
  // **デスクトップのプリセットで測る** — 既定はモバイル（4G 相当の回線 + CPU 4 倍の絞り込み）で、
  // 運用者が PC で開く社内の管理画面を測る条件としては実態に合わない。どちらで測るかは
  // 判定の前提なので ADR-0011 に残す（既定のモバイル条件での実測値もそこに書く）
  const result = await lighthouse(
    url,
    {
      // 起動済みの Chromium の CDP ポート
      port,
      // 機械で読む形
      output: 'json',
      // 進捗は出さない（標準出力は結果の 1 行だけにする）
      logLevel: 'error',
      // 基準が見るカテゴリだけ
      onlyCategories: [...LIGHTHOUSE_CATEGORIES],
      // 認証が要る画面はセッション Cookie を渡す（ログイン画面へ飛ばされると別の画面を測ってしまう）
      extraHeaders: cookie === null ? undefined : { Cookie: cookie },
    },
    // 公式のデスクトップ設定（回線・CPU・画面サイズの条件がここに入っている）
    desktopConfig,
  );
  // 結果が無ければ測れていない（理由を付けて落ちる。§6 握り潰さない）
  if (result === undefined) throw new Error(`Lighthouse が結果を返しません: ${url}`);
  // カテゴリごとの点数を 100 点満点へ直す
  const scores: Scores = {};
  for (const category of LIGHTHOUSE_CATEGORIES) {
    // そのカテゴリの点数（0〜1。欠けていれば測れていない）
    const score = result.lhr.categories[category]?.score;
    // 測れていなければ落ちる（0 点として扱うと「悪い」と「測れていない」が混ざる）
    if (typeof score !== 'number') throw new Error(`${category} を測れません: ${url}`);
    scores[category] = Math.round(score * SCORE_SCALE);
  }
  return scores;
}

/** 数の中央値（奇数回しか測らないので、並べて真ん中を取るだけでよい）。 */
function median(values: number[]): number {
  // 小さい順に並べる（元の配列を壊さない）
  const sorted = [...values].sort((left, right) => left - right);
  // 真ん中の値
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

/**
 * そのページを `LIGHTHOUSE_RUNS` 回測って**中央値**を返す。
 *
 * **1 回の計測では判定に使えない。** 同じコミット・同じ機械で測り直すと Performance が
 * 81〜98 の幅で揺れた（実測）。Lighthouse 自身も「複数回の中央値を見る」ことを勧めている。
 * 中央値にするのは、たまたま遅かった 1 回でゲートが赤くなるのを避けるため（平均だと外れ値が残る）。
 */
async function measure(url: string, port: number, cookie: string | null): Promise<Scores> {
  // 各回の点数
  const runs: Scores[] = [];
  // 決めた回数だけ測る（直列。並列にすると互いの CPU を奪って数字が落ちる）
  for (let round = 0; round < LIGHTHOUSE_RUNS; round += 1) {
    runs.push(await measureOnce(url, port, cookie));
  }
  // カテゴリごとに中央値を取る
  const scores: Scores = {};
  for (const category of LIGHTHOUSE_CATEGORIES) {
    scores[category] = median(runs.map((run) => run[category] ?? Number.NaN));
  }
  return scores;
}

// 計測本体
async function main(): Promise<void> {
  // 専用 DB を空にして画面を開くのに必要な行を仕込む（開発 DB なら 1 行も書かずに落ちる）
  const seed = await seedE2eFixture();
  // 空いているポートを 2 つ**同時に**取る（アプリと Chromium の CDP）。
  // 1 つずつ取ると同じ番号が返りうる（閉じた直後のポートは即座に再割り当てされる）ため、
  // 先に起動したアプリが占有して Chromium の CDP が bind に失敗し、原因と無関係な
  // 「Lighthouse が繋がらない」でゲートが落ちる
  const [appPort, debugPort] = await freePorts(2);
  // 2 つ揃わなければ測れない（fail-closed）
  if (appPort === undefined || debugPort === undefined) {
    throw new Error('計測に使うポートを取得できません');
  }
  // 本番ビルドを起動する
  const app = await startApp(appPort);
  // Chromium を起動する（CDP を開けて Lighthouse に繋がせる）
  const browser = await chromium.launch({
    executablePath: chromiumExecutablePath(),
    args: [`--remote-debugging-port=${debugPort}`],
  });
  try {
    // 測った結果（画面ごと）
    const pages: { page: string; scores: Scores }[] = [];
    // 画面一覧のとおりに測る（一覧が唯一の宣言。ここで並べ直さない）
    for (const screen of STEP5_SCREENS) {
      // 認証が要る画面にはセッション Cookie を渡す（値はトークンそのもの。ADR-0011）
      const cookie = screen.auth ? `${SESSION_COOKIE_NAME}=${seed.token}` : null;
      // この画面の URL（エージェント詳細は仕込んだ id を差し込む）
      const url = `http://127.0.0.1:${appPort}${screenPath(screen, seed)}`;
      // 測って束ねる
      pages.push({ page: screen.key, scores: await measure(url, debugPort, cookie) });
    }
    // **結果を 1 行の JSON で出す**（合否はゲートが判定する）
    console.log(
      JSON.stringify({
        measure: 'lighthouse',
        // 受け入れ基準の上限（正本から読んだ値。ゲートは自分の正本と突き合わせる）
        minScore: LIGHTHOUSE_MIN_SCORE,
        // 見たカテゴリ（ゲートは「全カテゴリが揃っているか」も見る）
        categories: LIGHTHOUSE_CATEGORIES,
        // 1 画面あたり何回測ってその中央値を出したか（人が結果を読むときの前提）
        runs: LIGHTHOUSE_RUNS,
        // 画面ごとの点数
        pages,
      }),
    );
  } finally {
    // 起動したものを必ず片付ける（§8 リソースを確実に解放する）
    await browser.close();
    stopApp(app);
  }
}

// 失敗は理由を出して非 0 終了（測れていないのに緑にしない）
main().catch((error: unknown) => {
  // 原因を残す（§6 握り潰さない）
  console.error('[lighthouse] 測定に失敗しました:', error instanceof Error ? error.message : error);
  // 非 0 終了（ゲートは終了コードも見る）
  process.exitCode = 1;
});
