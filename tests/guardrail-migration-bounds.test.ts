// マイグレーションの CHECK 制約に書いた数値が、TypeScript 側の定数と一致することを固定する。
//
// **SQL は TypeScript の定数を import できない**ので、ここだけは値を 2 か所に書くことになる。
// 写しがあるのに誰も突き合わせないと、片方だけを緩めたときに「アプリは通すが DB が拒否する」
// (利用者から見れば原因不明の 500) か、逆に「DB は通すがアプリが判定できない値が入る」
// (fail-open) のどちらかが静かに成立する。だから機械的に突き合わせる (§6 の「写しを持つなら検査する」)。
//
// **期待値は手書きせず、どちらの側も実体から読む** — 定数は import し、SQL は実ファイルを読む。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GUARDRAIL_COST_THRESHOLD_MAX,
  GUARDRAIL_WINDOW_MAX_MINUTES,
  GUARDRAIL_WINDOW_MIN_MINUTES,
} from '@/lib/constants';

// CHECK 制約を足しているマイグレーションの場所 (このテストが見る唯一のファイル)
const MIGRATION_PATH = join(
  process.cwd(),
  'prisma/migrations/20261002000000_add_audit_log_chain/migration.sql',
);

// マイグレーションの中身 (モジュールの評価時に 1 度だけ読む)
const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');

/**
 * 「列 演算子 数値」が制約の本文に書かれているかを、**数値の境界まで見て**確かめる。
 *
 * 素の `toContain` だと桁を増やす変異を捨てる: `"windowMinutes" <= 100800` は
 * `"windowMinutes" <= 10080` を部分文字列として含むので、上限を 10 倍に緩める差分が
 * 全件緑のまま通る (実測)。このリポジトリが料金表のテスト名で踏んだ `gpt-5` / `gpt-5-mini` と
 * 同じ形なので、同じ手当て (直後が数字でないことを要求する) をする。
 */
function hasBound(body: string, column: string, operator: string, value: number): boolean {
  // 列名・演算子・数値をそのまま並べた形を探す (空白は 1 つに正規化された前提)
  const needle = `"${column}" ${operator} ${value}`;
  // 出現位置を順に見て、直後の文字が数字でないものがあれば一致とみなす
  for (let from = body.indexOf(needle); from !== -1; from = body.indexOf(needle, from + 1)) {
    // 数値の直後の文字 (末尾なら undefined)
    const next = body[from + needle.length];
    // 数字が続いていなければ、その数値そのものが書かれている
    if (next === undefined || !/\d/.test(next)) return true;
  }
  // どの出現も桁が続いていた (= 別の数値だった)
  return false;
}

// 制約の定義を名前で切り出す (制約名から次のセミコロンまで)。
// **見つからなければ null を返し、呼び出し側が fail-closed で落とす** —
// 制約が消えた・名前が変わったときに「探せないので検査しない」で素通りさせない
function constraintBody(name: string): string | null {
  // 制約名の出現位置を探す
  const start = migrationSql.indexOf(`CONSTRAINT "${name}"`);
  // 無ければ切り出せない
  if (start === -1) return null;
  // そこから最初のセミコロンまでが 1 つの ALTER TABLE 文
  const end = migrationSql.indexOf(';', start);
  // 閉じていなければ切り出せない
  return end === -1 ? null : migrationSql.slice(start, end);
}

describe('ガードレールの CHECK 制約は TypeScript の定数と一致する', () => {
  it('集計窓の範囲が GUARDRAIL_WINDOW_MIN/MAX_MINUTES と一致する', () => {
    // 制約の定義を取り出す (無ければここで落ちる = fail-closed)
    const body = constraintBody('GuardrailRule_window_minutes_in_range');
    expect(body, '集計窓の CHECK 制約が見つかりません').not.toBeNull();
    // 下限と上限の両方が定数と同じ数値で書かれていること (桁を増やす変異も落とす)
    expect(hasBound(body!, 'windowMinutes', '>=', GUARDRAIL_WINDOW_MIN_MINUTES)).toBe(true);
    expect(hasBound(body!, 'windowMinutes', '<=', GUARDRAIL_WINDOW_MAX_MINUTES)).toBe(true);
  });

  it('コストのしきい値の上限が GUARDRAIL_COST_THRESHOLD_MAX と一致する', () => {
    // 制約の定義を取り出す
    const body = constraintBody('GuardrailRule_threshold_in_range');
    expect(body, 'しきい値の CHECK 制約が見つかりません').not.toBeNull();
    // 倍精度で正確に表せる上限 (2^53-1) が同じ数値で書かれていること
    expect(hasBound(body!, 'threshold', '<=', GUARDRAIL_COST_THRESHOLD_MAX)).toBe(true);
  });

  it('割合で表す種別のしきい値は 0〜1 に絞られている', () => {
    // 制約の定義を取り出す
    const body = constraintBody('GuardrailRule_threshold_in_range');
    expect(body, 'しきい値の CHECK 制約が見つかりません').not.toBeNull();
    // コスト以外 (エラー率・品質) は 0〜1。**上限が無いと「永久に発火しない」設定が作れる**
    // (エラー率は 1 を超えないので、threshold が 1 より大きければ何が起きても発火しない)
    expect(body).toContain('ELSE "threshold" >= 0 AND "threshold" <= 1');
    // 上限の 1 が「1 で終わる別の数値」に差し替えられていないこと
    expect(hasBound(body!, 'threshold', '<=', 1)).toBe(true);
  });

  it('追記専用トリガが UPDATE と DELETE の両方に張られている', () => {
    // トリガの宣言を探す (どちらかが抜けると、その操作だけ素通りする)
    expect(migrationSql).toContain('BEFORE UPDATE OR DELETE ON "AuditLog"');
    // 行ごとに評価する (文トリガだと 1 文で複数行を消したときに 1 回しか呼ばれない)
    expect(migrationSql).toContain('FOR EACH ROW');
  });
});
