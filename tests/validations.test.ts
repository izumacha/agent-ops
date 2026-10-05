// 本文のスキーマ (src/lib/validations) のうち、HTTP 層を通さないと気付けない性質を固定する。
// ここで見るのは「入力が黙って別の値に化ける」形 — 本番では Next / undici の本文パイプラインが
// NUL を落とすため `ag<NUL>ent` が `agent` として保存され、一意判定も後者で行われる (実測)。
// テストが組み立てる Request では NUL が残るので、明示的に弾いておかないと
// 「テストが見ている本文」と「本番が受け取る本文」が食い違ったままになる
import { describe, expect, it } from 'vitest';
import { agentCreateSchema, agentUpdateSchema } from '@/lib/validations/agent';
import { apiKeyCreateSchema } from '@/lib/validations/api-key';
import { RESOURCE_ID_MAX_LENGTH } from '@/domain/resource-id';
import { auditChainVerifyQuerySchema } from '@/lib/validations/guardrail';
import { FIRST_AUDIT_SEQ, MAX_AUDIT_SEQ } from '@/domain/audit/seq';
import { PG_BIGINT_MAX_DIGITS } from '@/domain/pg-bigint';
import { Provider } from '@/domain/types';

// NUL 文字 (ソースに直接書かず組み立てる)
const NUL = String.fromCharCode(0);
// ベル文字 (改行・タブ以外の制御文字の代表)
const BELL = String.fromCharCode(7);

// エージェント登録の最小限の妥当な本文 (個々のテストで 1 項目だけ壊す)
function validAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // 妥当な値に上書きを重ねる
  return { name: 'ボット', provider: Provider.anthropic, model: 'claude-sonnet-4-6', ...overrides };
}

describe('短い文字列 (表示名)', () => {
  it.each([
    ['NUL を含む', `ag${NUL}ent`],
    ['制御文字を含む', `ag${BELL}ent`],
    ['改行を含む', 'ag\nent'],
  ])('%s 名前は受け付けない', (_label, name) => {
    // 制御文字が混ざった名前は 422 相当 (検証エラー)
    expect(agentCreateSchema.safeParse(validAgent({ name })).success).toBe(false);
  });

  it('対になっていないサロゲートは受け付けない (保存時に U+FFFD へ化けるため)', () => {
    // JSON の `\ud800` で送れる形。長さ・文字種の検査は通ってしまうのでここで弾く
    const lone = `X${String.fromCharCode(0xd800)}Y`;
    expect(agentCreateSchema.safeParse(validAgent({ name: lone })).success).toBe(false);
  });

  it('対になったサロゲート (絵文字) は受け付ける (検証が広すぎないこと)', () => {
    // 絵文字はサロゲートペアなので正当な入力
    expect(agentCreateSchema.safeParse(validAgent({ name: '🤖 ボット' })).success).toBe(true);
  });

  it('ふつうの日本語の名前は受け付ける', () => {
    // 検証が広すぎて正規の入力を落としていないこと
    expect(agentCreateSchema.safeParse(validAgent()).success).toBe(true);
  });
});

describe('長い文字列 (説明文)', () => {
  it('改行とタブは許す (複数行の説明文が書けること)', () => {
    // 説明文は複数行になりうるので改行・タブは正当な入力
    const parsed = agentUpdateSchema.safeParse({ description: '1 行目\n\t2 行目' });
    expect(parsed.success).toBe(true);
  });

  it('説明文でも対になっていないサロゲートは許さない', () => {
    // 説明文も同じ理由で化けるので弾く
    const lone = `d${String.fromCharCode(0xdc00)}tail`;
    expect(agentUpdateSchema.safeParse({ description: lone }).success).toBe(false);
  });

  it('改行以外の制御文字は許さない', () => {
    // NUL が混ざった説明文は弾く (DB へ渡すと PostgreSQL が拒否する)
    expect(agentUpdateSchema.safeParse({ description: `説明${NUL}文` }).success).toBe(false);
  });
});

describe('本文に載る資源 id (API キー発行の agentId)', () => {
  it.each([
    ['NUL を含む', NUL],
    ['スラッシュを含む', 'a/b'],
    ['長すぎる', 'a'.repeat(RESOURCE_ID_MAX_LENGTH + 1)],
  ])('%s agentId は受け付けない', (_label, agentId) => {
    // 自由文ではなく id の規則で見る (形の違う値をそのまま DB へ渡すと 500 になる)
    expect(apiKeyCreateSchema.safeParse({ name: 'キー', agentId }).success).toBe(false);
  });

  it('cuid の形の agentId は受け付ける', () => {
    // 実際に発行される id の形 (英数字) は通る
    const parsed = apiKeyCreateSchema.safeParse({
      name: 'キー',
      agentId: 'clz0abcd1234efgh5678ijkl',
    });
    expect(parsed.success).toBe(true);
  });

  it('agentId を省略した本文は受け付ける (任意項目のまま)', () => {
    // 紐づけないキーも発行できる
    expect(apiKeyCreateSchema.safeParse({ name: 'キー' }).success).toBe(true);
  });
});

// 連鎖の検証の `fromSeq` の境界。判定そのものは共有の `parsePgBigint`（`tests/pg-bigint.test.ts`
// が形と範囲を固定する）に任せているので、ここで見るのは**この画面の下限と上限が実際に効いて
// いるか**。とくに上限は `MAX_AUDIT_SEQ` が列の型の上限から導かれていることに依存しているため、
// 導出が崩れた（＝小さい値に置き換えた）ときにここで落ちる必要がある
describe('連鎖の検証の fromSeq', () => {
  it('上限ちょうどは受け付ける', () => {
    // 「越えたら弾く」の副作用で上限そのものを弾いてしまう退行を防ぐ
    const parsed = auditChainVerifyQuerySchema.safeParse({ fromSeq: MAX_AUDIT_SEQ.toString() });
    expect(parsed.success).toBe(true);
    // 文字列ではなく BigInt へ直って出てくる（JSON の数値だと 2^53 を超えて別の行を指す）
    expect(parsed.success && parsed.data.fromSeq).toBe(MAX_AUDIT_SEQ);
  });

  it('下限ちょうども受け付ける', () => {
    // 先頭の行を明示的に指す呼び出し（nextFromSeq を追わない運用）を壊さない
    expect(
      auditChainVerifyQuerySchema.safeParse({ fromSeq: FIRST_AUDIT_SEQ.toString() }).success,
    ).toBe(true);
  });

  it('下限より小さい値は受け付けない', () => {
    // 0 を通すと「先頭より前」を指す呼び出しが成立してしまう（錨の計算が意味を失う）
    const parsed = auditChainVerifyQuerySchema.safeParse({
      fromSeq: (FIRST_AUDIT_SEQ - 1n).toString(),
    });
    expect(parsed.success).toBe(false);
  });

  it.each([
    // 上限の 1 つ上（桁数は収まるので、値の比較が効いていないと素通りする）
    ['上限を 1 だけ越えた値', (MAX_AUDIT_SEQ + 1n).toString()],
    // 桁数の上限を超える長さ（`BigInt` へ直す前に落ちる経路）
    ['桁数の上限を越えた値', '9'.repeat(PG_BIGINT_MAX_DIGITS + 1)],
  ])('%s は受け付けない（DB へ渡すと 500 になる）', (_label, fromSeq) => {
    // 範囲外の連番が `where: { seq: { gte: … } }` へ届くと PostgreSQL が拒否する
    expect(auditChainVerifyQuerySchema.safeParse({ fromSeq }).success).toBe(false);
  });
});
