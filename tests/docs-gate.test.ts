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
  it('gate:step1 のしきい値がロードマップと RBAC の許可表と一致する', () => {
    // 見るゲートスクリプトの名前 (Step 番号はここから導く。番号の写しを別に持たない)
    const gateScript = 'gate-step1.mjs';
    // ゲートの本文
    const gate = readFileSync(join(process.cwd(), 'scripts', gateScript), 'utf8');
    // テスト件数の下限 (読めなければ検出網が死んでいるので落とす)
    const required = gate.match(/^const REQUIRED_PASSED_TESTS = (\d+);$/m);
    expect(required, 'REQUIRED_PASSED_TESTS を読めない').not.toBeNull();
    // ロードマップの「その Step の行」だけを見る。**表全体を対象にしない** — 別の行にある
    // 「ADR 3 件以上」(Step0 の基準) にたまたま一致するので、下限を 3 にした変異が素通りする
    // (実測で全件緑のまま通った)。数字の途中への一致も許さない (0 にすると「60 件以上」の末尾に当たる)
    const stepNumber = /^gate-step(\d+)\.mjs$/.exec(gateScript)?.[1];
    expect(stepNumber, 'ゲートスクリプト名から Step 番号を読めない').toBeDefined();
    const roadmap = readFileSync(join(DOCS, 'roadmap.md'), 'utf8');
    // 表の行のうち、先頭の列がその Step 番号で始まるもの
    const stepRow = roadmap
      .split('\n')
      .find((line) => new RegExp(`^\\|\\s*${stepNumber}\\s`).test(line));
    expect(stepRow, `ロードマップに Step ${stepNumber} の行が無い`).toBeDefined();
    expect(stepRow ?? '', 'ロードマップの件数とゲートの下限がずれている').toMatch(
      new RegExp(`(?<![0-9])${required?.[1]} 件以上`),
    );
    // 役割と操作の一覧が許可表と一致すること (許可表が唯一の真実の源。ゲートはその写しを持っている)
    const roles = gate.match(/^const ROLES = \[(.*)\];$/m);
    const actions = gate.match(/^const ACTIONS = \[(.*)\];$/m);
    expect(roles, 'ROLES を読めない').not.toBeNull();
    expect(actions, 'ACTIONS を読めない').not.toBeNull();
    // 文字列リテラルの一覧を取り出す小さなヘルパー
    const literals = (source: string): string[] =>
      [...source.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(literals(roles?.[1] ?? '').sort()).toEqual(Object.keys(PERMISSIONS).sort());
    // 操作は許可表の値 (全役割の許可集合の和) から導く
    const allActions = new Set(Object.values(PERMISSIONS).flatMap((set) => [...set]));
    expect(literals(actions?.[1] ?? '').sort()).toEqual([...allActions].sort());
  });

  // 生成元と計画書が消えていないことを固定する
  it('OpenAPI 定義とロードマップが存在する', () => {
    // 生成元と計画書の存在確認
    expect(existsSync(join(process.cwd(), 'openapi', 'openapi.yaml'))).toBe(true);
    expect(existsSync(join(DOCS, 'roadmap.md'))).toBe(true);
  });
});
