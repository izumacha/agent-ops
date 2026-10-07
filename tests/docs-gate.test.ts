// Vitest のテスト API
import { describe, expect, it } from 'vitest';
// ファイル操作 (Node 標準)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
// git に追跡対象を聞く共通部分 (起動失敗と「走って失敗」を分ける判定はここが正本)
import { CHILD_TIMEOUT_MS, gitTrackedFiles } from './lib/child-process';
// パス結合 (Node 標準)
import { join } from 'node:path';
import { importSharedModule, sharedModuleNames } from './lib/script-files';

// docs/ の場所
const DOCS = join(process.cwd(), 'docs');

// 追跡集合は 1 回だけ聞いて使い回す (検査ごとに git を起こさない)。**`expect` を含むので
// モジュール評価時ではなく最初のテストの中で解決する**
let trackedCache: string[] | undefined;
function trackedOnce(): string[] {
  // 1 度目だけ git へ聞く
  trackedCache ??= gitTrackedFiles('.');
  // 2 度目以降は覚えておいた結果
  return trackedCache;
}
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
// **見るのはこれ 1 つだけ: 「追跡されていて、いま在る」docs/ 直下の対象が、すべてカタログに
// 載っていること。** 手がかりは一覧そのものではなく **git の追跡集合と作業ツリー**で、
// 一覧を一覧自身と突き合わせる形では載せ忘れた 1 枚がこの検査からも同時に外れる。
// `readdirSync` だけにしないのは、未追跡・gitignore 対象・隠しディレクトリまで「載せろ」と
// 要求して**実行不能な指示**になるため (`docs/.vitepress/` を作っただけで落ちた)。逆に追跡
// だけを見ると、**まだコミットしていない削除**で「載せろ」と言われ、従うと 404 の行が残る
// (実測)。だから**両方の積**を採る。
//
// **リンクの妥当性は一切見ない（意図的な線引き）。** 見ようとして Markdown のリンクを正規表現で
// 取り出した版は、6 巡にわたって穴と誤検知を交互に出し続けた (実測): コメントとコードフェンス
// (``` と `~~~`、入れ子)・題名付き・アンカー付き・ルート絶対・空の宛先・参照形式・山括弧の
// 宛先・括弧を含む宛先・脚注の定義・**書き方を説明する例そのもの**。**実装の粗さではなく
// 高度 (altitude) の誤り**で、Markdown の文法を自前で再実装し続ける限り終わらない (同じ道を
// CSP の検査で通り、判定をブラウザへ渡して解決した記録がこのリポジトリ群にある)。
// **自前の文法解析へ戻さないこと。** いまの照合は「名前がカタログの本文に現れるか」の素朴な
// 部分文字列一致だけで、取りこぼしても**誤って赤くなる側には倒れない**。
//
// **そのぶん守備範囲は狭い。機械で見ていないものを数えておく:**
// (1) **リンク先の実在**。`docs/overview.md` の ADR へのリンクも README の導線も、
// **カタログ自身の行**も見ない — 文書を消した・改名したときに**取り残された行**は落ちない。
// (2) カタログの行を HTML コメントやコードフェンスへ移す形 (本文に名前が残るので要求は
// 満たされる)。(3) `docs/adr/` のような**サブディレクトリの中身** (ディレクトリ 1 行で指すので、
// ADR を 1 本足しても何も要求しない)。どれも規約とレビューで守る。
describe('docs/ の入口の鮮度', () => {
  // 入口そのもの (この表に載るべき対象から外す)
  const INDEX = 'index.md';

  it(
    'index.md が docs/ 直下の追跡対象すべて (ファイルとディレクトリ) を指している',
    () => {
      // 追跡されている docs/ 配下のパス
      const tracked = trackedOnce().filter((path) => path.startsWith('docs/'));
      // **追跡されていて、いま作業ツリーにも在るものだけ**を対象にする
      const present = tracked.filter((path) => existsSync(join(process.cwd(), path)));
      // docs/ 直下の名前へ畳む (`docs/adr/0001-x.md` → `adr/`、`docs/spec.md` → `spec.md`)
      const entries = [
        ...new Set(
          present.map((path) => {
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
      // **`git ls-files` は未追跡でも exit 0 で空を返す**ので、`gitTrackedFiles` の
      // 「走って失敗した」の判定には掛からない — リリース tarball を別のリポジトリ配下へ
      // 展開した場合がこれで、原因を名指ししないと読む側は「カタログの対象が消えた」と
      // 読んでしまう (実測で exit 0 ＋ 空だった)
      expect(
        entries.length,
        'docs/ から対象を 1 件も導けていない（`git ls-files` は未追跡でも exit 0 で空を返すので、' +
          'このディレクトリが agent-ops の git 作業ツリーでない可能性もある）',
      ).toBeGreaterThan(0);
      // **名前に空白や括弧を使わない**ことを規約として要求する — 照合は `](./名前)` の素朴な
      // 一致なので、空白を含む名前はその形でしか通らないが、Markdown は宛先を最初の空白で
      // 切るので**その行は壊れたリンクとして描画される**。つまり満たせる形が壊れた形しか無い。
      // 「山括弧で囲む」を受けると宛先の文法を解析する側へ戻るので、名前の側を縛る
      for (const entry of entries) {
        // 空白と括弧を含まないこと
        expect(
          /[\s()#<>|]/.test(entry),
          `docs/${entry} の名前に空白・括弧・# < > | がある（カタログの照合が素朴な一致なので、名前はこれらなしで付ける。| はカタログが GFM の表なので行が割れる）`,
        ).toBe(false);
      }
      // カタログそのものの在処
      const indexPath = join(DOCS, INDEX);
      // **もう 1 つの前提も名指しする** — 入口が無ければ素の ENOENT で落ち、読む側は
      // 「カタログが消えた」のか「検査が壊れた」のかを区別できない
      expect(existsSync(indexPath), `docs/${INDEX}（カタログそのもの）が無い`).toBe(true);
      // カタログの本文
      const index = readFileSync(indexPath, 'utf8');
      // 1 件ずつ、名前が本文に現れるかを見る
      for (const entry of entries) {
        // リンクの宛先として書かれている形 (`](./spec.md)` / `](./adr/)`)。**`./` を要求するのは
        // カタログの書き方の取り決めで、文法の解析ではない**。**失敗文言に要求する形を書く** —
        // 「載っていない」だけだと、題名やアンカーを付けた行が見えているのに行が無いものとして
        // 探され、同じ文書の行を 2 つ足す方向へ誘導される
        expect(
          index,
          `docs/${entry} の行が \`](./${entry})\` の形で docs/${INDEX} に無い` +
            '（題名・アンカー・山括弧は付けない）',
        ).toContain(`](./${entry})`);
      }
    },
    CHILD_TIMEOUT_MS,
  );
});

// 行スコープ方式（**テナントに属する資源が** `tenantId` を持つ）の**例外**を
// `prisma/schema.prisma` から導き、散文の件数と名指しがそれと一致していることを固定する。
//
// **なぜ要るか**: この repo の docs に出てくる数値は例外なく定数と突き合わせてある
// （ユースケース件数 ↔ `REQUIRED_USE_CASES`、プラン表 ↔ `PLAN_LIMITS`、しきい値 ↔
// `stepN-criteria.mjs`、画面の枚数 ↔ `STEP5_SCREENS`）。例外の件数はその規律から外れた
// 唯一の絶対数で、出所はスキーマにしか無い。1 つ増えたとき（`tenantId String?` の
// テーブルを足す・親経由だけの子テーブルを足す）、全テストが緑のまま散文が古い数を
// 言い続け、**同じ段落が「非 null を前提にするな」と警告している相手を取りこぼす**。
//
// **nullable 側は型が止めてくれない。** 列を持たないモデルに `where: { tenantId }` を書くと
// Prisma の型が拒むので typecheck で止まるが、`tenantId String?` のモデルは通る —
// 顧客 ID からテナントを引けなかった行だけが黙って集計から落ちる。だから散文の鮮度が
// 実害に直結する。
//
// **照合先は手書きの一覧ではなく導出から作る**（この repo の規約: 違反の一覧を表で持つと、
// 載せ忘れたファイルがこの検査からも同時に外れる）。追跡されている散文のファイル（拡張子の
// 一覧は `TEXT_FILE` が正本。**全ファイルではない**）から
// 「`例外は N つ` と `tenantId` を同じ段落に書いているところ」を拾い、*(1)* その N が導出と
// 一致すること、*(2)* 例外のモデル名を 1 つでも挙げている段落は**全部**挙げていること、
// *(3)* 正本（`docs/spec.md`）はちょうど 1 段落でその全部を挙げていること、を要求する。
// *(2)* を「名前を挙げているなら」に条件付けているのは、README のように**正本を指すだけで
// 列挙しない**書き方を正しいまま通すため（実測で、全段落に名指しを要求する版は README の
// ディレクトリ表で落ちた）。
//
// **見ているのは件数と名前だけ。** 説明の正しさ（どちらがどの理由の例外か・どう扱えばよいか）
// は見ていないので、規約とレビューで守る。
describe('tenantId の例外（行スコープ方式）の散文', () => {
  // テナントそのもの（`tenantId` ではなく `id` でテナントを表す分離境界）なので例外に数えない
  const BOUNDARY_MODEL = 'Tenant';
  // 散文を走査する拡張子。**「全ファイル」ではない**ので、守備範囲はここが正本:
  // `.md` / `.ts` / `.mts` / `.tsx` / `.mjs` / `.prisma` / `.yml` / `.yaml` / `.json`。
  // 画像・動画・SQL・`.env.example` のような拡張子の無いものは読まない（件数をそこへ書くと
  // 黙って古くなる。**新しい置き場所へ書くときはここへ足す**）
  const TEXT_FILE = /\.(md|ts|mts|tsx|mjs|prisma|ya?ml|json)$/;
  // ロックファイルは読まない（散文を持たないのに最も大きい。走査の無駄）
  const SKIP_FILE = /(^|\/)package-lock\.json$/;
  // 件数の表記（「例外は N つ」の形。全角・半角の空白ゆらぎを許す）。
  // **このコメントに数字を書かない** — 走査が自分の記法の例を「主張」として読み、
  // 件数が変わったときに意味の無い編集を要求する（この describe が撤退した誤検知の型）
  const COUNT_PHRASE = /例外は\s*(\d+)\s*つ/g;
  // 箇条書き・表の行の始まり（新しい「箇所」の区切り）
  const BLOCK_START = /^\s*([-*+]\s|\|)/;

  // 本文を「箇所」へ割る。**空行で割るだけでは粗すぎる** — 箇条書きも表も空行で区切られない
  // ので、実測で README のディレクトリ表 15 行ぜんぶが 1 つの段落、CLAUDE.md の箇条書きが
  // 7〜8 行で 1 つになっていた。その単位で `tenantId` と件数を突き合わせると、**同じ箇条書きの
  // 隣の項目**が別の主題（カバレッジの除外など）で「例外は N つ」と書いただけで落ちる —
  // 正しい編集を赤にする検出網はいずれ緩められるので、単位を箇条・表の行まで割る
  function splitBlocks(text: string): string[] {
    // 集めた箇所
    const blocks: string[] = [];
    // まず空行で段落へ
    for (const paragraph of text.split(/\n\s*\n/)) {
      // 組み立て中の箇所
      let current: string[] = [];
      // 行ごとに見る
      for (const line of paragraph.split('\n')) {
        // 箇条・表の行に当たったら、そこまでを 1 つの箇所として確定する
        if (BLOCK_START.test(line) && current.length > 0) {
          // 確定
          blocks.push(current.join('\n'));
          // 次の箇所へ
          current = [];
        }
        // 継続行はその箇所に属する
        current.push(line);
      }
      // 段落の残りを確定する
      if (current.length > 0) blocks.push(current.join('\n'));
    }
    // 箇所の一覧
    return blocks;
  }

  // 箇所がモデル名を名指ししているか。**バッククォートを要求しない** — 散文は
  // `BillingEvent.tenantId` と列まで書くことがあり、スキーマのコメントのように記法そのものが
  // 無い場所もある（実測で、`` `名前` `` だけを探す版は両方を取りこぼした）。
  // **規則は 1 か所だけに置く** — 正本側の照合で同じ式を書き直すと、片方だけ緩められる
  function mentionsModel(text: string, name: string): boolean {
    // 語の境界で探す（モデル名は `\w+` なので正規表現のメタ文字は入らない）
    return new RegExp(`\\b${name}\\b`).test(text);
  }

  it(
    '例外のモデル名と件数が prisma/schema.prisma から導いたものと一致する',
    () => {
      // **読む前に「スキーマが 1 枚であること」を確かめる**（Prisma 7 はフォルダへ分割できる。
      // 分割すると `prisma/schema.prisma` が無くなり、読み取りが素の ENOENT で落ちて、
      // そのために書いた下の文言に辿り着けない — 読む側は「スキーマが移った」のか
      // 「検査が壊れた」のかを区別できない。カタログの在処を先に見るのと同じ手当て）
      // **重複を畳む** — 未解決のマージでは `git ls-files` が同じパスをステージごとに出すので、
      // 畳まないと「分割した」という**起きていない原因**を名指しして落ちる（下の走査と同じ手当て）
      expect(
        [...new Set(trackedOnce().filter((path) => path.endsWith('.prisma')))],
        'prisma の定義ファイルが 1 枚ではない（分割したら、この検査の読む範囲も広げる）',
      ).toEqual(['prisma/schema.prisma']);
      // スキーマ本文
      const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
      // `model X { ... }` を全部取る。**本体の終わりは行頭の `}` で決める** — `[^}]*` にすると
      // `meta Json @default("{}")` のような**文字列リテラル中の波括弧**で本体が途中で切れ、
      // その手前に `tenantId` があるモデルまで「列を持たない」側へ落ちる（実測で `AuditLog` が
      // 例外として数えられ、**正しくない理由で赤くなった**）
      const models = [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map((match) => ({
        // モデル名
        name: match[1],
        // 本体（フィールドの並び）
        body: match[2],
      }));
      // **1 つも取れなければ落とす**（「対象ゼロ＝緑」を避ける fail-closed）
      expect(
        models.length,
        'prisma/schema.prisma から model を 1 つも導けていない',
      ).toBeGreaterThan(0);
      // **宣言の数と取れた数が一致すること。** 本体の終わりを行頭の `}` で決めているので、
      // **閉じ括弧が字下げされた model**（Prisma としては妥当。`prisma format` を CI で
      // 走らせていないので起こりうる）があると、そのモデルの本体が次のモデルまで伸びて
      // **2 つまとめて取りこぼす** — 実測で、`tenantId String?` を持つモデルを字下げした
      // 閉じ括弧で足すと「例外ではない」と判定され、全件緑のまま素通りした（fail-open）。
      // 括弧の置き方を解析しに行くのではなく、**数が合わないことで落とす**
      expect(
        models.length,
        'model の宣言の数と、本体まで取れた数が合わない（閉じ括弧が行頭に無い model がある。`prisma format` で整えるか、宣言の書き方をそろえる）',
      ).toBe((schema.match(/^model\s+\w+/gm) ?? []).length);
      // **飲み込み先が `model` 以外なら、上の件数は一致したままになる。** 実測で、字下げした
      // 閉じ括弧の model のうしろに `type`（または `view`）を置くと、本体がその宣言まで伸びて
      // `tenantId` を拾い「例外ではない」と判定され、`model` の数は変わらないので全件緑で
      // 素通りした。**本体の中に別のトップレベル宣言が現れていないこと**を直接見る
      for (const model of models) {
        // 本体に別の宣言の始まりが混ざっていないこと
        expect(
          model.body,
          `model ${model.name} の本体が別の宣言まで伸びている（閉じ括弧が行頭に無い model がある。\`prisma format\` で整えるか、宣言の書き方をそろえる）`,
        ).not.toMatch(/^(model|enum|type|view|datasource|generator)\s+\w+/m);
      }
      // **境界のモデルが居ることも前提**（名前を変えたら除外が黙って効かなくなる）
      expect(
        models.some((model) => model.name === BOUNDARY_MODEL),
        `prisma/schema.prisma に model ${BOUNDARY_MODEL}（分離境界）が無い`,
      ).toBe(true);
      // **`model` 以外の宣言が無いことも前提**（fail-closed）。導出は `^model` しか見ないので、
      // `view`（PostgreSQL で使える preview 機能）や `type` がテナントの資源を `tenantId`
      // 無しで持つと、**3 つめの例外なのに導出にも散文にも現れない**（実測で全件緑だった。
      // 本体の飲み込みの検査は、括弧が正しく書かれていれば何も言わない）。足す人が導出を
      // 広げるように、ここで止める
      expect(
        schema.match(/^(view|type)\s+\w+/gm) ?? [],
        'prisma/schema.prisma に view / type がある（テナントの資源を持ちうるので、tenantId の例外の導出を `^model` から広げる）',
      ).toEqual([]);
      // 境界以外から、`tenantId String`（非 null）を持たないモデルを例外として拾う。
      // 型が `String` 以外の場合も「持たない」側へ倒れる（fail-closed。多めに要求して落ちる側）
      const exceptions = models
        .filter((model) => model.name !== BOUNDARY_MODEL)
        .filter((model) => !/^\s*tenantId\s+String(?!\?)/m.test(model.body))
        .map((model) => model.name)
        .sort();
      // 導出の要約（失敗の文言で使う）
      const summary = `${exceptions.length} 件: ${exceptions.join(' / ')}`;
      // 走査対象（手書きの一覧を持たない）。**「追跡されていて、いま在る」ものだけ**を見る —
      // 追跡だけを見ると、**まだコミットしていない削除**（改名の途中がこの状態）で素の ENOENT に
      // なり、消そうとしているファイルを指した意味の分からない赤になる（上の検査と同じ手当て）
      const files = trackedOnce().filter(
        (path) =>
          TEXT_FILE.test(path) && !SKIP_FILE.test(path) && existsSync(join(process.cwd(), path)),
      );
      // **1 件も拾えなければ落とす**（走査対象ゼロ＝緑を避ける fail-closed）
      expect(files.length, '走査対象のテキストファイルを 1 件も導けていない').toBeGreaterThan(0);
      // 「件数の表記と `tenantId` が同じ箇所にある」ところを集める
      const mentions: { file: string; block: string; counts: number[] }[] = [];
      // ファイルごとに見る。**重複を畳む** — 未解決のマージでは `git ls-files` が同じパスを
      // ステージごとに出すので、畳まないと同じファイルを 3 回読んで失敗も 3 重に出る
      for (const file of [...new Set(files)]) {
        // 本文
        const text = readFileSync(join(process.cwd(), file), 'utf8');
        // 箇所ごとに見る
        for (const block of splitBlocks(text)) {
          // 行スコープの話でなければ対象外（別の主題の「例外は N つ」を巻き込まない）
          if (!block.includes('tenantId')) continue;
          // 件数の表記を全部取る
          const counts = [...block.matchAll(COUNT_PHRASE)].map((match) => Number(match[1]));
          // 1 つも無ければ対象外
          if (counts.length === 0) continue;
          // 対象として覚える
          mentions.push({ file, block, counts });
        }
      }
      // **1 件も無ければ落とす** — 散文から件数が消えたら、この検査は何も見ていない
      expect(
        mentions.length,
        `「例外は N つ」と tenantId を同じ箇所に書いたところが 1 つも無い（導出: ${summary}）`,
      ).toBeGreaterThan(0);
      // 箇所ごとに件数と名指しを見る
      for (const mention of mentions) {
        // 件数がすべて導出と一致すること
        for (const count of mention.counts) {
          // ずれていれば、どのファイルの何件がずれているかを言って落とす
          expect(
            count,
            `${mention.file} の「例外は ${count} つ」が導出（${summary}）と合っていない`,
          ).toBe(exceptions.length);
        }
        // 1 つも挙げていない（正本を指すだけの書き方）ならここでは何も要求しない
        if (!exceptions.some((name) => mentionsModel(mention.block, name))) continue;
        // 挙げているなら**全部**挙げていること（古い部分集合のまま件数だけ更新されるのを防ぐ）
        for (const name of exceptions) {
          // 抜けているモデル名を名指しして落とす
          expect(
            mentionsModel(mention.block, name),
            `${mention.file} は tenantId の例外を挙げているのに ${name} が抜けている（導出: ${summary}）`,
          ).toBe(true);
        }
      }
      // **正本（spec.md）はちょうど 1 箇所で全部を挙げていること** — 0 なら件数がずれており、
      // 2 つ以上あるとどちらが古いかを機械では決められない
      const specMentions = mentions.filter((mention) => mention.file === 'docs/spec.md');
      // 正本の箇所の数
      expect(
        specMentions.length,
        `docs/spec.md に「例外は N つ」と tenantId を含む箇所がちょうど 1 つ無い（${specMentions.length} 個）`,
      ).toBe(1);
      // 正本は 1 件ずつ名指ししていること（**上の「挙げているなら全部」とは別**に、
      // 「1 つも挙げない」書き方を正本には許さない）
      for (const name of exceptions) {
        // 正本がモデル名を名指ししていること
        expect(
          mentionsModel(specMentions[0].block, name),
          `tenantId の例外 ${name} が docs/spec.md の該当箇所で名指しされていない`,
        ).toBe(true);
      }
    },
    CHILD_TIMEOUT_MS,
  );
});
