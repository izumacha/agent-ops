// 本文のスキーマ (src/lib/validations) のうち、HTTP 層を通さないと気付けない性質を固定する。
// ここで見るのは「入力が黙って別の値に化ける」形 — 本番では Next / undici の本文パイプラインが
// NUL を落とすため `ag<NUL>ent` が `agent` として保存され、一意判定も後者で行われる (実測)。
// テストが組み立てる Request では NUL が残るので、明示的に弾いておかないと
// 「テストが見ている本文」と「本番が受け取る本文」が食い違ったままになる
import { describe, expect, it } from 'vitest';
import { agentCreateSchema, agentUpdateSchema } from '@/lib/validations/agent';
import { apiKeyCreateSchema } from '@/lib/validations/api-key';
import { RESOURCE_ID_MAX_LENGTH } from '@/domain/resource-id';
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
