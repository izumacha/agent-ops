// Vitest のテスト API
import { describe, expect, it } from 'vitest';
// ファイル操作 (Node 標準)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
// パス結合 (Node 標準)
import { join } from 'node:path';

// docs/ の場所
const DOCS = join(process.cwd(), 'docs');
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

  // 生成元と計画書が消えていないことを固定する
  it('OpenAPI 定義とロードマップが存在する', () => {
    // 生成元と計画書の存在確認
    expect(existsSync(join(process.cwd(), 'openapi', 'openapi.yaml'))).toBe(true);
    expect(existsSync(join(DOCS, 'roadmap.md'))).toBe(true);
  });
});
