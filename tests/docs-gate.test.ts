// Vitest のテスト API
import { describe, expect, it } from 'vitest';
// ファイル操作 (Node 標準)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
// パス結合 (Node 標準)
import { join } from 'node:path';
import { importSharedModule, sharedModuleNames } from './lib/script-files';

// docs/ の場所
const DOCS = join(process.cwd(), 'docs');
// 定数の正本 (文書に書かれた数値と突き合わせる)
import { PLATFORM_ADMIN_TOKEN_MIN_LENGTH } from '@/lib/constants';
// RBAC の許可表 (役割と操作の唯一の真実の源)
import { PERMISSIONS } from '@/domain/rbac';
// Step1 の受け入れ基準の値 (ゲートが読むのと同じ定義)。**名前空間でも読む** —
// 「ゲート本体が基準を宣言し直していないか」を、公開されている名前の一覧から導くため
import { ACTIONS, REQUIRED_PASSED_TESTS, ROLES } from '../scripts/lib/step1-criteria.mjs';
// Step2 のベンチのしきい値 (ロードマップの散文と突き合わせる)
import {
  PROXY_ADDED_LATENCY_P95_MAX_MS,
  USAGE_AGGREGATE_MAX_MS,
  USAGE_AGGREGATE_ROW_COUNT,
} from '../scripts/lib/step2-criteria.mjs';
// Step3 のベンチのしきい値 (同じくロードマップの散文と突き合わせる)
import {
  EVALUATION_AGREEMENT_MIN_PERCENT,
  EVALUATION_BENCH_CASE_COUNT,
} from '../scripts/lib/step3-criteria.mjs';
// Step4 のベンチのしきい値 (同じくロードマップの散文と突き合わせる)
import { GUARDRAIL_STOP_MAX_MS } from '../scripts/lib/step4-criteria.mjs';
// Step5 の受け入れ基準 (Lighthouse の合格点と画面の枚数。同じく散文と突き合わせる)
import { LIGHTHOUSE_MIN_SCORE, STEP5_SCREENS } from '../scripts/lib/step5-criteria.mjs';

// Step0 の受け入れ基準 (docs/roadmap.md と一致させる)
const REQUIRED_USE_CASES = 10;
const REQUIRED_ADRS = 3;

describe('Step0 の設計成果物', () => {
  // ユースケースの件数を見出しの数で固定する
  it(`docs/spec.md にユースケースが ${REQUIRED_USE_CASES} 件以上ある`, () => {
    // 仕様書を読む
    const spec = readFileSync(join(DOCS, 'spec.md'), 'utf8');
    // 「### UC-01」形式の見出しを数える
    const useCases = spec.match(/^### UC-\d{2}/gm) ?? [];
    expect(useCases.length).toBeGreaterThanOrEqual(REQUIRED_USE_CASES);
  });

  // ER 図と API 一覧の節が存在することを固定する
  it('docs/spec.md に ER 図 (mermaid erDiagram) と API 一覧がある', () => {
    // 仕様書を読む
    const spec = readFileSync(join(DOCS, 'spec.md'), 'utf8');
    // ER 図と API 一覧の節があること
    expect(spec).toMatch(/```mermaid\s*\nerDiagram/);
    expect(spec).toMatch(/^## .*API 一覧/m);
  });

  // ADR の件数と書式 (ステータス行) を固定する
  it(`docs/adr/ に ADR が ${REQUIRED_ADRS} 件以上あり、状態が明記されている`, () => {
    // 「0001-xxx.md」形式のファイルを数える
    const adrs = readdirSync(join(DOCS, 'adr')).filter((name) => /^\d{4}-.+\.md$/.test(name));
    expect(adrs.length).toBeGreaterThanOrEqual(REQUIRED_ADRS);
    // 各 ADR が「ステータス」行を持つこと (未決の記録を混ぜない)
    for (const name of adrs) {
      const body = readFileSync(join(DOCS, 'adr', name), 'utf8');
      expect(body, `${name} にステータスが無い`).toMatch(
        /^- \*\*ステータス\*\*: (採択|廃止|置換)/m,
      );
    }
  });

  // 運用者が読む 3 つの文書と、実装が使う定数が同じ数値を言っていることを固定する
  // (写しが 3 か所あるので、定数を下げても文書が古い値のまま残り「32 文字以上と書いてあるのに 6 文字が通る」
  //  状態を作れてしまう。文書側だけを直しても同じ)
  it(`プラットフォーム管理者トークンの最小長 ${PLATFORM_ADMIN_TOKEN_MIN_LENGTH} が文書と一致する`, () => {
    // 実装の値を文書の書き方 (「32 文字以上」) に合わせた文字列
    const expected = `${PLATFORM_ADMIN_TOKEN_MIN_LENGTH} 文字以上`;
    // 運用者がこの値を読む 3 か所
    for (const path of [
      join(DOCS, 'adr', '0005-bearer-token-auth.md'),
      join(process.cwd(), '.env.example'),
      join(process.cwd(), 'README.md'),
    ]) {
      // その数値が本文に現れること
      expect(readFileSync(path, 'utf8'), `${path} の最小長が実装とずれている`).toContain(expected);
    }
  });

  // ゲートの受け入れ基準が、正本 (ロードマップの散文と RBAC の許可表) と一致していることを固定する。
  // 「基準を緩める変更はテスト側だけを書き換えない」(ADR-0004) を支えているのはこのスクリプトだけなのに、
  // その値を照合する検査が無かった。実測では件数の下限を 0 にしても、役割の一覧を 1 要素にしても全件緑で、
  // 役割が 4 種に増えてもゲートは 3 × 3 しか要求しないままだった
  // ロードマップの「その Step の行」を取り出す (表全体を対象にしない — 別の行にある
  // 「ADR 3 件以上」(Step0 の基準) にたまたま一致し、下限を 3 にした変異が素通りするため。実測で確認)
  function roadmapStepRow(stepNumber: number): string {
    // ロードマップを読む
    const roadmap = readFileSync(join(DOCS, 'roadmap.md'), 'utf8');
    // 表の行のうち、先頭の列がその Step 番号で始まるもの
    const row = roadmap
      .split('\n')
      .find((line) => new RegExp(`^\\|\\s*${stepNumber}\\s`).test(line));
    // 行が無ければ照合が成り立たない (fail-closed)
    expect(row, `ロードマップに Step ${stepNumber} の行が無い`).toBeDefined();
    return row ?? '';
  }

  it('Step1 の受け入れ基準の値がロードマップと RBAC の許可表と一致する', () => {
    // 件数の下限は Step1 の行の散文と一致すること (数字の途中への一致は許さない)
    expect(roadmapStepRow(1), 'ロードマップの件数とゲートの下限がずれている').toMatch(
      new RegExp(`(?<![0-9])${REQUIRED_PASSED_TESTS} 件以上`),
    );
    // 役割と操作の一覧が許可表と一致すること (許可表が唯一の真実の源。基準側はその写しを持っている)
    expect([...ROLES].sort()).toEqual(Object.keys(PERMISSIONS).sort());
    // 操作は許可表の値 (全役割の許可集合の和) から導く
    const allActions = new Set(Object.values(PERMISSIONS).flatMap((set) => [...set]));
    expect([...ACTIONS].sort()).toEqual([...allActions].sort());
  });

  // **ゲート本体に基準の値を書かせない。** 値を各ゲートが自分で宣言できると、新しい Step の
  // ゲートで静かに緩められる (上の照合は共有の定義しか見ないので気付けない)。
  // **見張る名前は基準モジュールの export から導く** — 手書きの一覧にすると、新しい基準を
  // 足した人が一覧へ足し忘れたぶんだけ検出網が静かに狭まる (実測で、名前を 2 つ直書きしていた
  // 当時は PROXY_ADDED_LATENCY_P95_MAX_MS をゲート本体で宣言し直しても全件緑で通った)。
  // 対象は scripts/gate-step*.mjs の全部で、1 本も見つからなければ走査が壊れている (fail-closed)。
  //
  // **残る境界: 見ているのは「宣言の形」だけで、呼び出し側の直書きは素通りする。**
  // 実測でも `evaluateStep2Report({ requiredPassedTests: REQUIRED_PASSED_TESTS, … })` を
  // `requiredPassedTests: 1` に書き換えると、この検査も tests/gate-scripts.test.ts も緑のまま通った。
  // 引数名と識別子の対応を見る形は書けるが、引数名を変えるだけで崩れるので採らない。
  // **基準の値が実際に渡っているかはレビューで見る**（この repo の他の除外表と同じ扱い）
  it('ゲート本体は受け入れ基準の値を自分で宣言しない (共有の定義を読む)', async () => {
    // **見張る名前は「共有モジュールが公開している定数」から導く。**
    // 以前は import した 2 本を手で並べており、3 本目 (bench-criteria.mjs) が増えた時点で
    // そこへ置いた値は照合から外れていた (実測: ゲート本体で宣言し直しても全件緑)。
    // 次に `*-criteria.mjs` というファイル名の手がかりへ変えたが、それも
    // **別の名前 (`*-thresholds.mjs` 等) にリネームするだけで外れる** (実測で再現した)。
    // ファイル名ではなく **UPPER_SNAKE_CASE の定数を公開しているか**を手がかりにする
    const sharedModules = sharedModuleNames();
    // 1 本も見つからなければ走査が壊れている (fail-closed)
    expect(sharedModules.length, '共有モジュールを 1 本も見つけられない').toBeGreaterThan(0);
    // 公開されている定数の名前を集める (関数は判定なので対象外)
    const criteriaNames = (
      await Promise.all(
        sharedModules.map(async (name) => {
          // 読み込みは共有ヘルパー経由 (ファイル URL の組み立てを 2 か所へ書き写さない)
          const loaded = await importSharedModule(name);
          // 定数の綴り (UPPER_SNAKE_CASE) だけを見る
          return Object.keys(loaded).filter(
            (key) => /^[A-Z][A-Z0-9_]*$/.test(key) && typeof loaded[key] !== 'function',
          );
        }),
      )
    ).flat();
    // 1 つも読めなければ照合が空振りしている
    expect(criteriaNames.length, '基準モジュールから名前を 1 つも読めない').toBeGreaterThan(0);
    // ゲートスクリプトの一覧
    const gateScripts = readdirSync(join(process.cwd(), 'scripts')).filter((name) =>
      /^gate-step\d+\.mjs$/.test(name),
    );
    // 1 本も無ければ走査が壊れている
    expect(gateScripts.length, 'ゲートスクリプトを 1 本も見つけられない').toBeGreaterThan(0);
    // どのゲートも基準の名前を自分で宣言していないこと (const / let / var のどれでも)
    for (const name of gateScripts) {
      const source = readFileSync(join(process.cwd(), 'scripts', name), 'utf8');
      for (const criterion of criteriaNames) {
        expect(source, `${name} が受け入れ基準 ${criterion} を直接宣言している`).not.toMatch(
          new RegExp(`^\\s*(?:const|let|var)\\s+${criterion}\\s*=`, 'm'),
        );
      }
    }
  });

  // Step2 の 3 つの基準のうち、ベンチが測る 2 つ (遅延・集計) のしきい値を散文と突き合わせる。
  // 値はスクリプトとロードマップの 2 か所に現れるので、片方だけを緩める変更をここで落とす
  it('Step2 のベンチのしきい値がロードマップと一致する', () => {
    // ロードマップの Step2 の行 (行の取り出しは Step1 側と同じヘルパーを使う)
    const stepRow = roadmapStepRow(2);
    // 追加遅延の上限 (散文は「p95 ≦ 50ms」)
    expect(stepRow, '追加遅延の上限がずれている').toContain(`${PROXY_ADDED_LATENCY_P95_MAX_MS}ms`);
    // 投入件数 (散文は「1 万件」。定数から万の単位へ直して突き合わせる)
    expect(stepRow, '投入件数がずれている').toContain(`${USAGE_AGGREGATE_ROW_COUNT / 10_000} 万件`);
    // 集計の上限 (散文は「≦ 1 秒」。定数はミリ秒なので秒へ直す)
    expect(stepRow, '集計の上限がずれている').toContain(`${USAGE_AGGREGATE_MAX_MS / 1_000} 秒`);
  });

  // Step3 の受け入れ基準のうち、ベンチが測る 2 つ (セットの件数・再現率) を散文と突き合わせる。
  // Step2 と同じ理由 — 値はベンチとロードマップの 2 か所に現れるので、
  // 「ベンチのしきい値だけを緩めて緑にする」変更をここで落とす
  it('Step3 のベンチのしきい値がロードマップと一致する', () => {
    // ロードマップの Step3 の行
    const stepRow = roadmapStepRow(3);
    // 固定評価セットの件数 (散文は「固定評価セット 100 件」。数字の途中への一致は許さない)
    expect(stepRow, 'ロードマップの件数とベンチの件数がずれている').toMatch(
      new RegExp(`(?<![0-9])${EVALUATION_BENCH_CASE_COUNT} 件`),
    );
    // 再現率の下限 (散文は「再現率 ≧ 90%」)
    expect(stepRow, '再現率の下限がずれている').toMatch(
      new RegExp(`(?<![0-9])${EVALUATION_AGREEMENT_MIN_PERCENT}%`),
    );
  });

  // Step4 の受け入れ基準のうち、ベンチが測る 1 つ (発火から停止まで) を散文と突き合わせる。
  // Step2 / Step3 と同じ理由 — 値はベンチとロードマップの 2 か所に現れるので、
  // 「ベンチのしきい値だけを緩めて緑にする」変更をここで落とす
  it('Step4 のベンチのしきい値がロードマップと一致する', () => {
    // ロードマップの Step4 の行
    const stepRow = roadmapStepRow(4);
    // 発火から停止までの上限 (散文は「≦ 3 秒」。定数はミリ秒なので秒へ直す。
    // 数字の途中への一致は許さない — 「30 秒」へ緩める差分を「3 秒」が拾わないようにする)
    expect(stepRow, '発火から停止までの上限がずれている').toMatch(
      new RegExp(`(?<![0-9])${GUARDRAIL_STOP_MAX_MS / 1_000} 秒`),
    );
  });

  // Step5 の受け入れ基準のうち数で書けるもの (Lighthouse の合格点・画面の枚数) を散文と突き合わせる。
  // Step2〜4 と同じ理由 — 値は正本 (scripts/lib/step5-criteria.mjs) とロードマップの 2 か所に
  // 現れるので、「ゲートのしきい値だけを緩めて緑にする」変更をここで落とす
  it('Step5 の受け入れ基準がロードマップと一致する', () => {
    // ロードマップの Step5 の行
    const stepRow = roadmapStepRow(5);
    // Lighthouse の合格点 (散文は「≧ 90」。数字の途中への一致は許さない)
    expect(stepRow, 'Lighthouse の合格点がずれている').toMatch(
      new RegExp(`(?<![0-9])${LIGHTHOUSE_MIN_SCORE}(?![0-9])`),
    );
    // 画面の枚数 (散文は「主要 5 画面」。一覧の件数から導く)
    expect(stepRow, '画面の枚数がずれている').toMatch(
      new RegExp(`(?<![0-9])${STEP5_SCREENS.length} 画面`),
    );
  });

  // README の見出しの「現在の段階」がロードマップと食い違っていないことを固定する。
  // この行は CLAUDE.md §15 が言う「5 秒で伝わる要約」そのものなので、
  // Step を足したときに更新し忘れると、README が自分の中で矛盾する
  // (実際 Step3 を実装した PR で、見出しだけ Step2 のまま残っていた)
  it('README の「現在の段階」がロードマップの最新の実装済み Step と一致する', () => {
    // ロードマップの表から「実装済み」と書かれた行の Step 番号を集める
    const roadmap = readFileSync(join(DOCS, 'roadmap.md'), 'utf8');
    const implemented = roadmap
      .split('\n')
      .filter((line) => /^\|\s*\d/.test(line) && line.includes('実装済み'))
      .map((line) => Number(/^\|\s*(\d+)/.exec(line)?.[1]));
    // 1 つも読めなければ照合が成り立たない (fail-closed)
    expect(implemented.length, 'ロードマップに実装済みの Step が 1 つも無い').toBeGreaterThan(0);
    // そのうち最大が「最新の実装済み Step」
    const latest = Math.max(...implemented);
    // README の見出しの行 (「現在の段階:」で始まる箇条書き)
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
    const statusLine = readme.split('\n').find((line) => line.includes('現在の段階:'));
    // 行が無ければ照合が成り立たない (fail-closed)
    expect(statusLine, 'README に「現在の段階」の行が無い').toBeDefined();
    // その行が名乗る Step 番号が最新と一致すること
    expect(statusLine, 'README の「現在の段階」がロードマップと食い違っている').toMatch(
      new RegExp(`Step${latest}(?![0-9])`),
    );
  });

  // 生成元と計画書が消えていないことを固定する
  it('OpenAPI 定義とロードマップが存在する', () => {
    // 生成元と計画書の存在確認
    expect(existsSync(join(process.cwd(), 'openapi', 'openapi.yaml'))).toBe(true);
    expect(existsSync(join(DOCS, 'roadmap.md'))).toBe(true);
  });
});
