// Vitest のテスト API
import { describe, expect, it } from 'vitest';
// ファイル操作 (Node 標準)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
// パス結合 (Node 標準)
import { join } from 'node:path';

// docs/ の場所
const DOCS = join(process.cwd(), 'docs');
// 定数の正本 (文書に書かれた数値と突き合わせる)
import { PLATFORM_ADMIN_TOKEN_MIN_LENGTH } from '@/lib/constants';
// RBAC の許可表 (役割と操作の唯一の真実の源)
import { PERMISSIONS } from '@/domain/rbac';
// Step1 の受け入れ基準の値 (ゲートが読むのと同じ定義)
import { ACTIONS, REQUIRED_PASSED_TESTS, ROLES } from '../scripts/lib/step1-criteria.mjs';
// Step2 のベンチのしきい値 (ロードマップの散文と突き合わせる)
import {
  PROXY_ADDED_LATENCY_P95_MAX_MS,
  USAGE_AGGREGATE_MAX_MS,
  USAGE_AGGREGATE_ROW_COUNT,
} from '../scripts/lib/step2-criteria.mjs';

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

  // **ゲート本体に基準の数値を書かせない。** 値を各ゲートが自分で宣言できると、新しい Step の
  // ゲートで静かに緩められる (上の照合は共有の定義しか見ないので気付けない)。
  // 対象は scripts/gate-step*.mjs の全部で、1 本も見つからなければ走査が壊れている (fail-closed)
  it('ゲート本体は受け入れ基準の数値を自分で宣言しない (共有の定義を読む)', () => {
    // ゲートスクリプトの一覧
    const gateScripts = readdirSync(join(process.cwd(), 'scripts')).filter((name) =>
      /^gate-step\d+\.mjs$/.test(name),
    );
    // 1 本も無ければ走査が壊れている
    expect(gateScripts.length, 'ゲートスクリプトを 1 本も見つけられない').toBeGreaterThan(0);
    // どのゲートも「= 数値」の形で基準を宣言していないこと
    for (const name of gateScripts) {
      const source = readFileSync(join(process.cwd(), 'scripts', name), 'utf8');
      expect(source, `${name} が受け入れ基準の数値を直接宣言している`).not.toMatch(
        /^const REQUIRED_PASSED_TESTS = \d+;$/m,
      );
      expect(source, `${name} が役割の一覧を直接宣言している`).not.toMatch(/^const ROLES = \[/m);
    }
  });

  // Step2 の 3 つの基準のうち、ベンチが測る 2 つ (遅延・集計) のしきい値を散文と突き合わせる。
  // 値はスクリプトとロードマップの 2 か所に現れるので、片方だけを緩める変更をここで落とす
  it('Step2 のベンチのしきい値がロードマップと一致する', () => {
    // ロードマップの Step2 の行
    const roadmap = readFileSync(join(DOCS, 'roadmap.md'), 'utf8');
    const stepRow = roadmap.split('\n').find((line) => /^\|\s*2\s/.test(line));
    expect(stepRow, 'ロードマップに Step 2 の行が無い').toBeDefined();
    // 追加遅延の上限 (散文は「p95 ≦ 50ms」)
    expect(stepRow ?? '', '追加遅延の上限がずれている').toContain(
      `${PROXY_ADDED_LATENCY_P95_MAX_MS}ms`,
    );
    // 投入件数 (散文は「1 万件」。定数から万の単位へ直して突き合わせる)
    expect(stepRow ?? '', '投入件数がずれている').toContain(
      `${USAGE_AGGREGATE_ROW_COUNT / 10_000} 万件`,
    );
    // 集計の上限 (散文は「≦ 1 秒」。定数はミリ秒なので秒へ直す)
    expect(stepRow ?? '', '集計の上限がずれている').toContain(
      `${USAGE_AGGREGATE_MAX_MS / 1_000} 秒`,
    );
  });

  // 生成元と計画書が消えていないことを固定する
  it('OpenAPI 定義とロードマップが存在する', () => {
    // 生成元と計画書の存在確認
    expect(existsSync(join(process.cwd(), 'openapi', 'openapi.yaml'))).toBe(true);
    expect(existsSync(join(DOCS, 'roadmap.md'))).toBe(true);
  });
});
