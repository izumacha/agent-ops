// Vitest のテスト API
import { describe, expect, it } from 'vitest';
// ファイル操作 (Node 標準)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
// 子プロセスの実行 (git に追跡対象を聞く)
import { execFileSync } from 'node:child_process';
// パス結合 (Node 標準)
import { join } from 'node:path';
import { importSharedModule, sharedModuleNames } from './lib/script-files';

// docs/ の場所
const DOCS = join(process.cwd(), 'docs');
// 定数の正本 (文書に書かれた数値と突き合わせる)
import { PLATFORM_ADMIN_TOKEN_MIN_LENGTH } from '@/lib/constants';
// 監査ログの連番の上限 (README が運用者向けに数値で書いているので突き合わせる)
import { MAX_AUDIT_SEQ } from '@/domain/audit/seq';
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
// Step6 の受け入れ基準 (カバレッジの下限と計測対象。同じく散文と突き合わせる)
import {
  COVERAGE_EXCLUDE,
  COVERAGE_INCLUDE,
  COVERAGE_MIN_PERCENT,
} from '../scripts/lib/step6-criteria.mjs';
// Step7 の受け入れ基準 (デモが動くまでの上限・同時接続・エラー率・既知の問題の文書)
import {
  CONCURRENCY_CONNECTIONS,
  CONCURRENCY_MAX_ERROR_PERCENT,
  DEMO_READY_MAX_MS,
  DEMO_STEP_COUNT,
  KNOWN_ISSUES_DOC,
} from '../scripts/lib/step7-criteria.mjs';
// プラン別の上限の正本 (spec.md の表はこれの写しなので突き合わせる)
import { PLAN_FEATURES, PLAN_LIMITS, planAllows } from '@/domain/plan';
// プランの一覧 (enum の正準)
import { Plan } from '@/domain/types';

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

  // 同じ事情で README にある連番の上限も突き合わせる。**OpenAPI 側の写しには既に検査がある**
  // (tests/openapi.test.ts) のに、運用者が読む README だけが素のままだと、定数を下げたときに
  // 「README には上限と書いてあるのに API はもっと狭い」状態が静かに残る
  it(`連鎖の検証の fromSeq の上限 ${MAX_AUDIT_SEQ.toString()} が README と一致する`, () => {
    // 実装の値を README の書き方 (「1 以上 … 以下」) に合わせた文字列
    const expected = `${MAX_AUDIT_SEQ.toString()} 以下`;
    // 運用者がこの値を読む場所
    expect(
      readFileSync(join(process.cwd(), 'README.md'), 'utf8'),
      'README の fromSeq の上限が実装とずれている',
    ).toContain(expected);
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

  // Step6 の受け入れ基準のうち数で書けるもの (カバレッジの下限) と、計測対象の宣言を散文と
  // 突き合わせる。**この Step は「全体カバレッジ」の解釈を狭めている**ので (ロジック層に限る)、
  // ゲート運用ルール 4「基準を緩める変更はロードマップと ADR を同じ PR で更新する」の
  // 裏打ちがここに要る — 実測でしきい値を 0 にしてもゲートは緑のまま通った
  it('Step6 の受け入れ基準がロードマップと一致する', () => {
    // ロードマップの Step6 の行
    const stepRow = roadmapStepRow(6);
    // カバレッジの下限 (散文は「≧ 80%」。数字の途中への一致は許さない)
    expect(stepRow, 'カバレッジの下限がずれている').toMatch(
      new RegExp(`(?<![0-9])${COVERAGE_MIN_PERCENT}%`),
    );
    // ロードマップ全体 (計測対象と除外は行に収まらないので別節に書いてある)
    const roadmap = readFileSync(join(DOCS, 'roadmap.md'), 'utf8');
    // **計測対象のディレクトリが散文に並んでいること** — 対象をこっそり狭める
    // (例: `src/app/api` を外す) 変更は、ゲートの判定だけ見ていると％が上がって緑になる
    for (const pattern of COVERAGE_INCLUDE) {
      // glob の部分を外した「ディレクトリの名前」で照合する
      const directory = pattern.replace(/\/\*\*.*$/, '');
      expect(roadmap, `計測対象 ${directory} がロードマップに書かれていない`).toContain(directory);
    }
    // **除外も同じく書かれていること** (除外表に増える差分をレビューで見るための前提)
    for (const pattern of COVERAGE_EXCLUDE) {
      // 同じくディレクトリ/ファイルの名前で照合する
      const target = pattern.replace(/\/\*\*.*$/, '');
      expect(roadmap, `除外 ${target} がロードマップに書かれていない`).toContain(target);
    }
  });

  // spec.md のプラン表で、その機能の可否が書かれている列の添字を返す。
  // **見出しに機能の識別子 (`auditChainVerify` など) を書いておく**ので、機能を足したときに
  // 列を作り忘れればここで落ちる (列の順番を変えても追随する)
  function featureColumnOf(feature: string): number {
    // 仕様書を読む
    const spec = readFileSync(join(DOCS, 'spec.md'), 'utf8');
    // プラン表の見出し行 (先頭のセルが「プラン」)
    const header = spec.split('\n').find((line) => /^\|\s*プラン\s*\|/.test(line));
    // 見出しが無ければ照合が成り立たない (fail-closed)
    expect(header, 'spec.md にプラン表の見出しが無い').toBeDefined();
    // 識別子をバッククォートで囲んだ形で探す
    const column = (header ?? '')
      .split('|')
      .findIndex((cell) => cell.includes('`' + feature + '`'));
    // 列が無ければ、その機能は表に載っていない
    expect(column, `spec.md のプラン表に ${feature} の列が無い`).toBeGreaterThan(0);
    return column;
  }

  // プラン別の上限は `src/domain/plan.ts` が正本で、spec.md の表はその写し。
  // **写しが腐ると「文書どおりに使えない API」になる**ので、値ごとに突き合わせる
  // (プランを足したときの書き忘れもここで落ちる)
  it('spec.md のプラン表が PLAN_LIMITS と一致する', () => {
    // 仕様書
    const spec = readFileSync(join(DOCS, 'spec.md'), 'utf8');
    // プランごとの行 (表の 1 行目のセルがプラン名)
    for (const plan of Object.values(Plan)) {
      // その行を探す (バッククォートで囲んだプラン名で始まる行)
      const row = spec.split('\n').find((line) => line.startsWith(`| \`${plan}\``));
      // 行が無ければ照合が成り立たない (fail-closed)
      expect(row, `spec.md に ${plan} の行が無い`).toBeDefined();
      // その行に 3 つの上限が書かれていること (数字の途中への一致は許さない)
      const limits = PLAN_LIMITS[plan];
      for (const value of [
        limits.maxAgents,
        limits.proxyRateLimitPerMinute,
        limits.maxEnabledGuardrailRules,
      ]) {
        expect(row, `${plan} の上限 ${value} が spec.md と食い違う`).toMatch(
          new RegExp(`(?<![0-9])${value}(?![0-9])`),
        );
      }
      // 可否も一致していること。**機能の一覧は正本から回す** — 機能名を決め打ちすると、
      // 2 つ目の機能を足したときに表から列ごと消えてもこの検査は緑のまま通る (しかも
      // 「どこかに『使えない』がある」だけの判定では、同じプランで可否が分かれる 2 機能を
      // 表現できず、判定そのものが誤りになる)
      const cells = row?.split('|').map((cell) => cell.trim()) ?? [];
      for (const feature of PLAN_FEATURES) {
        // その機能の列 (見出しに識別子が書いてある)
        const cell = cells[featureColumnOf(feature)] ?? '';
        // 列のセルが可否と一致すること (`使えない` は `使える` を含まないので取り違えない)
        expect(
          cell.includes(planAllows(plan, feature) ? '使える' : '使えない'),
          `${plan} の ${feature} の可否が spec.md と食い違う (列の中身は「${cell}」)`,
        ).toBe(true);
      }
    }
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

  // Step7 の受け入れ基準のうち数で書けるもの (デモが動くまでの上限・同時接続・エラー率) と、
  // **解釈を決めた節**がロードマップに書かれていることを突き合わせる。
  // この Step は基準①（`docker compose up` から 5 分）を 2 つの経路に割り、基準④（既知バグ 0）を
  // 「文書の表 ＋ ソースの印」に具体化しているので、ゲート運用ルール 4 の裏打ちがここに要る
  it('Step7 の受け入れ基準がロードマップと一致する', () => {
    // ロードマップの Step7 の行
    const stepRow = roadmapStepRow(7);
    // デモが動くまでの上限 (散文は「5 分以内」。定数はミリ秒なので分へ直す)
    expect(stepRow, 'デモが動くまでの上限がずれている').toMatch(
      new RegExp(`(?<![0-9])${DEMO_READY_MAX_MS / 60_000} 分`),
    );
    // 同時接続の数 (散文は「同時 100 リクエスト」)
    expect(stepRow, '同時接続の数がずれている').toMatch(
      new RegExp(`(?<![0-9])${CONCURRENCY_CONNECTIONS} リクエスト`),
    );
    // エラー率の上限 (散文は「< 1%」。**等号を含まない形で書いてある**)
    expect(stepRow, 'エラー率の上限がずれている').toContain(`< ${CONCURRENCY_MAX_ERROR_PERCENT}%`);
    // ロードマップ全体 (解釈は行に収まらないので別節に書いてある)
    const roadmap = readFileSync(join(DOCS, 'roadmap.md'), 'utf8');
    // **既知の問題の文書の場所が書かれていること** — ゲートが読む正本なので、
    // 置き場所を変えたときに運用の説明が取り残されない
    expect(roadmap, `${KNOWN_ISSUES_DOC} がロードマップに書かれていない`).toContain(
      KNOWN_ISSUES_DOC,
    );
    // **デモの段数が書かれていること** — 段を削って速くした計測を許さない基準なので、
    // 何段通すのかが文書からも読める必要がある
    expect(roadmap, 'デモの段数がロードマップに書かれていない').toMatch(
      new RegExp(`(?<![0-9])${DEMO_STEP_COUNT} 段`),
    );
  });

  // 生成元と計画書が消えていないことを固定する
  it('OpenAPI 定義とロードマップが存在する', () => {
    // 生成元と計画書の存在確認
    expect(existsSync(join(process.cwd(), 'openapi', 'openapi.yaml'))).toBe(true);
    expect(existsSync(join(DOCS, 'roadmap.md'))).toBe(true);
  });
});

// `docs/index.md` が docs/ の中身を取りこぼしていないことを固定する。
//
// **手がかりを一覧そのものではなく「git が追跡しているファイル」から採る。** `index.md` は
// 手書きのカタログで、文書を 1 枚足したときに書き足すのを忘れても lint も typecheck も何も
// 言わない (実測で `api.md` / `deploy.md` / `load-test.md` / `known-issues.md` の 4 件が
// Step5 以前の状態で取り残されていた)。一覧を一覧自身と突き合わせる形では、載せ忘れた 1 枚が
// この検査からも同時に外れるので、**導出とは独立な手がかり**と突き合わせる。
//
// **`readdirSync` を使わない** — 未追跡・gitignore 対象・隠しディレクトリまで返すので、
// `docs/.vitepress/` を 1 つ作っただけで落ち、しかも対処が「生成物をカタログに載せる」という
// 実行不能な指示になる (実測)。実行不能な指示を出す検出網はいずれ緩められる。
//
// **見るのは「掲載の網羅」だけで、リンク先の実在は見ない（意図的な線引き）。** リンク切れを
// 見るには Markdown のリンクを正しく取り出す必要があり、そのために正規表現で文法を組み立てて
// みたところ、1 巡ごとに新しい穴と誤検知が出続けた (実測): コメントとコードフェンス (``` と
// `~~~`、入れ子のフェンス)・題名付き・アンカー付き・ルート絶対・空の宛先・参照形式・山括弧の
// 宛先・括弧を含む宛先・脚注の定義。**これは実装の粗さではなく高度 (altitude) の誤り**で、
// Markdown の文法を自前で再実装し続ける限り終わらない (このリポジトリ群が CSP の検査で同じ
// 道を通り、判定をブラウザへ渡して解決した記録がある)。**自前の文法解析へ戻さないこと。**
// ここで使う照合は「追跡されている名前がカタログの本文に現れるか」の素朴な部分文字列一致
// だけで、取りこぼしても**誤って赤くなる側には倒れない**。
//
// **そのぶん守備範囲は狭い。機械で見ていないものを数えておく:**
// (1) リンク先の実在 (`docs/overview.md` の ADR へのリンクや README の導線を含め、どの文書の
// リンク切れも落ちない)。(2) カタログの行を HTML コメントやコードフェンスへ移す形 (本文に
// 名前が残るので掲載の要求は満たされる)。(3) `docs/adr/` のような**サブディレクトリの中身**
// (カタログはディレクトリ 1 行で指すので、ADR を 1 本足してもここは何も要求しない)。
// どれも規約とレビューで守る。
describe('docs/ の入口の鮮度', () => {
  // 入口そのもの (この表に載るべき対象から外す)
  const INDEX = 'index.md';

  it('index.md が docs/ 直下の追跡対象すべて (ファイルとディレクトリ) を指している', () => {
    // git が追跡しているパスをリポジトリ相対で全件取る (`-z` は NUL 区切り。改行を含むパスでも壊れない)
    const tracked = execFileSync('git', ['ls-files', '-z', '--', 'docs'], { encoding: 'utf8' })
      .split('\0')
      .filter((line) => line.length > 0);
    // docs/ 直下の名前へ畳む (`docs/adr/0001-x.md` → `adr/`、`docs/spec.md` → `spec.md`)
    const entries = [
      ...new Set(
        tracked.map((path) => {
          // `docs/` を外した残り
          const rest = path.slice('docs/'.length);
          // 最初の区切りまでがディレクトリ名
          const slash = rest.indexOf('/');
          // 区切りが無ければファイル、あればディレクトリ
          return slash < 0 ? rest : `${rest.slice(0, slash)}/`;
        }),
      ),
    ]
      .filter((name) => name !== INDEX)
      .sort();
    // **1 件も導けなければ落とす** (「対象ゼロ＝緑」を避ける fail-closed)
    expect(entries.length, 'docs/ から対象を 1 件も導けていない').toBeGreaterThan(0);
    // カタログの本文
    const index = readFileSync(join(DOCS, INDEX), 'utf8');
    // 1 件ずつ、名前が本文に現れるかを見る
    for (const entry of entries) {
      // リンクの宛先として書かれている形 (`](./spec.md)` / `](./adr/)`)。**`./` を要求するのは
      // カタログの書き方の取り決めで、文法の解析ではない** — 揃えておかないと照合のために
      // 書き方を数え上げることになり、上のコメントが言う高度の誤りへ戻る。**失敗文言に要求
      // する形を書く** — 「載っていない」だけだと、題名やアンカーを付けた行が見えているのに
      // 行が無いものとして探され、同じ文書の行を 2 つ足す方向へ誘導される
      expect(
        index,
        `docs/${entry} の行が \`](./${entry})\` の形で docs/${INDEX} に無い` +
          '（題名・アンカー・山括弧は付けない）',
      ).toContain(`](./${entry})`);
    }
    // **逆向きも見る** — 消した・改名した文書の行が取り残されると、カタログが唯一の入口
    // なので 404 の行が残り続ける（改名では新しい名前の要求だけが出るので、言われたとおり
    // 行を足すと古い行が残る）。**数え上げも素朴な部分文字列のまま**で、文法は解析しない
    expect(
      index.split('](./').length - 1,
      `docs/${INDEX} に docs/ 直下を指す行が ${entries.length} 件より多い（消した・改名した文書の行が残っている）`,
    ).toBe(entries.length);
  });
});
