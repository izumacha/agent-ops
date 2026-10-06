// 既存テナントのプランに関する「配備したときの振る舞い」を固定する。
//
// **文書の主張（ADR-0012 決定 1 の「プラン別にして緩くなった利用者はいない」）は、
// マイグレーションが無いと成り立たない。** `Tenant.plan` は Step0 から `@default(free)` で
// 存在したがどこからも読まれていなかったので、Step4 / Step5 まで動いていた配備の行は
// すべて free で、Step6 で free が意味を持った瞬間に上限が一斉に厳しくなる
// （中継 600 → 60 回/分、ルール 50 → 5 件、エージェント無制限 → 3 件、改ざん検証が 403）。
//
// ここで見るのは 2 つ: (a) 既存の行を pro へ上げるマイグレーションが実在すること、
// (b) **新しいテナントは free のまま**であること（列の既定値）。どちらもファイルを読むだけで、
// 期待する値は `Plan` の enum から導く（'pro' という綴りを書き写さない）。
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Plan } from '@/domain/types';

// マイグレーションの置き場
const MIGRATIONS_DIR = join(process.cwd(), 'prisma', 'migrations');
// スキーマの場所
const SCHEMA_PATH = join(process.cwd(), 'prisma', 'schema.prisma');

// すべてのマイグレーション SQL を読む（1 本も読めなければ走査が壊れている）
function migrationSqls(): { name: string; sql: string }[] {
  // ディレクトリ名がマイグレーションの名前
  const names = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  // それぞれの migration.sql を読む
  return names.map((name) => ({
    name,
    sql: readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'),
  }));
}

describe('既存テナントのプラン', () => {
  it('マイグレーションを 1 本以上読める（走査が壊れていない）', () => {
    // 0 本なら以下の照合が空振りで緑になる（fail-closed）
    expect(migrationSqls().length).toBeGreaterThan(0);
  });

  it('既存の行を pro へ上げるマイグレーションがある（配備で上限が厳しくならない）', () => {
    // `Tenant` の plan を更新する文を持つマイグレーションを探す
    const promoting = migrationSqls().filter(({ sql }) =>
      // 条件を絞らない全件 UPDATE（既存の行だけに当たるのは「1 度しか走らない」性質から）
      new RegExp(`UPDATE\\s+"Tenant"\\s+SET\\s+"plan"\\s*=\\s*'${Plan.pro}'`, 'i').test(sql),
    );
    // 1 本も無ければ、配備した瞬間に全テナントが free の上限になる
    expect(
      promoting.length,
      '既存テナントを pro へ上げるマイグレーションが無い（ADR-0012 決定 1 の主張が成り立たない）',
    ).toBeGreaterThan(0);
  });

  it('新しいテナントは free のまま（列の既定値を変えていない）', () => {
    // スキーマの `plan` 列の宣言
    const schema = readFileSync(SCHEMA_PATH, 'utf8');
    // 既定値が free であること（pro を既定にすると、試用のつもりの新規テナントが有料の枠を持つ）
    expect(schema, 'Tenant.plan の既定値が free でない').toMatch(
      new RegExp(`plan\\s+Plan\\s+@default\\(${Plan.free}\\)`),
    );
  });
});
