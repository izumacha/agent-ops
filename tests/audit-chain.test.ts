// 監査ログのハッシュ連鎖 (src/domain/audit/chain.ts) と鍵の読み出し (src/lib/audit/secret.ts) の検査。
// DB を触らない純粋ロジックなので、境界をここで全部固定する (§11)。
// **改ざん検知が「実際に検知する」ことの検査は 3 種類の壊れ方ごとに書く** —
// 1 種類だけ見ていると、他の壊れ方を素通りさせる実装でも緑になる
import { describe, expect, it } from 'vitest';
import {
  AuditChainBreak,
  auditRowHash,
  nextAuditSeq,
  verifyAuditChain,
  type AuditChainRow,
  type StoredAuditRow,
} from '@/domain/audit/chain';
import { auditHmacSecret, AUDIT_HMAC_SECRET_ENV } from '@/lib/audit/secret';
import { AUDIT_HMAC_SECRET_MIN_LENGTH } from '@/lib/constants';
import { secretsEqual } from '@/lib/tokens';

// 検査で使う鍵 (長さの下限を満たす固定値)
const SECRET = 'test-audit-hmac-secret-0123456789abcdef';
// 別の鍵 (鍵が違えばハッシュも違うことの確認用)
const OTHER_SECRET = 'test-audit-hmac-secret-fedcba9876543210';

// 環境変数を組み立てる (NODE_ENV は ProcessEnv で必須なので既定を入れる。tests/proxy-upstream.test.ts と同じ形)
function env(values: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  // 既定の NODE_ENV に、検査したい値を重ねる
  return { NODE_ENV: 'test', ...values } as NodeJS.ProcessEnv;
}

// 1 行ぶんの素材を作る (必要な項目だけ上書きできるようにする)
function row(overrides: Partial<AuditChainRow> = {}): AuditChainRow {
  // 既定値はテナント t1 の 1 件目
  return {
    tenantId: 't1',
    seq: 1n,
    actorId: 'u1',
    action: 'agent.suspend',
    targetType: 'Agent',
    targetId: 'ag1',
    payload: null,
    createdAt: new Date('2026-10-02T00:00:00.000Z'),
    prevHash: null,
    ...overrides,
  };
}

// 行の列から連鎖を組み立てる (各行のハッシュを順に計算して prevHash を繋ぐ)
function chainOf(secret: string, rows: readonly AuditChainRow[]): StoredAuditRow[] {
  // 直前のハッシュ (最初は無い)
  let previousHash: string | null = null;
  // 組み立てた行を入れる配列
  const built: StoredAuditRow[] = [];
  // 1 行ずつハッシュを計算する
  for (const [index, source] of rows.entries()) {
    // 連番は 1 始まりで振り直し、prevHash は直前のハッシュにする
    const linked: AuditChainRow = {
      ...source,
      seq: BigInt(index + 1),
      prevHash: previousHash,
    };
    // この行のハッシュ
    const hash = auditRowHash(secret, linked);
    // 保存された行として積む
    built.push({ ...linked, hash });
    // 次の行のために覚える
    previousHash = hash;
  }
  // 組み立てた連鎖
  return built;
}

describe('監査ログのハッシュ連鎖', () => {
  it('同じ行からは同じハッシュが出る (再計算で検証できる)', () => {
    // 同じ素材を 2 回通す
    expect(auditRowHash(SECRET, row())).toBe(auditRowHash(SECRET, row()));
  });

  it('鍵が違えばハッシュが変わる (鍵なしのハッシュに退化していない)', () => {
    // 同じ行・違う鍵
    expect(auditRowHash(SECRET, row())).not.toBe(auditRowHash(OTHER_SECRET, row()));
  });

  it('ハッシュに入れるどの列を変えてもハッシュが変わる', () => {
    // 基準のハッシュ
    const base = auditRowHash(SECRET, row());
    // 列ごとに 1 つだけ変えた行を作る (**ここに挙がっていない列は連鎖で守られていない**)
    const variants: Partial<AuditChainRow>[] = [
      { tenantId: 't2' },
      { seq: 2n },
      { actorId: 'u2' },
      { actorId: null },
      { action: 'agent.resume' },
      { targetType: 'GuardrailRule' },
      { targetId: 'ag2' },
      { payload: { kind: 'cost' } },
      { createdAt: new Date('2026-10-02T00:00:00.001Z') },
      { prevHash: 'deadbeef' },
    ];
    // どの 1 列を変えてもハッシュが動く
    for (const override of variants) {
      expect(auditRowHash(SECRET, row(override))).not.toBe(base);
    }
  });

  it('payload のキーの順序はハッシュに影響しない (JSONB はキー順を保存しない)', () => {
    // 同じ内容・違う挿入順
    const first = auditRowHash(SECRET, row({ payload: { a: '1', b: '2' } }));
    const second = auditRowHash(SECRET, row({ payload: { b: '2', a: '1' } }));
    // 正規化でキーを並べ替えるので一致する
    expect(first).toBe(second);
  });

  it('payload の値が違えばハッシュが変わる (キーだけ見ていない)', () => {
    // キーは同じで値だけ違う
    const first = auditRowHash(SECRET, row({ payload: { kind: 'cost' } }));
    const second = auditRowHash(SECRET, row({ payload: { kind: 'quality' } }));
    // 値も正規化に入っているので一致しない
    expect(first).not.toBe(second);
  });

  it('区切り文字を含む値で別の行と同じハッシュにできない', () => {
    // 連結して 1 本の文字列にする実装だと、区切り文字を値に入れて境界をずらせる。
    // **JSON の配列にしているので、この 2 つは別のハッシュになる**
    const left = auditRowHash(SECRET, row({ action: 'a|b', targetType: 'c' }));
    const right = auditRowHash(SECRET, row({ action: 'a', targetType: 'b|c' }));
    // 境界がずれていないことの確認
    expect(left).not.toBe(right);
  });

  it('壊れていない連鎖は ok を返す', () => {
    // 3 件の連鎖
    const rows = chainOf(SECRET, [row(), row({ action: 'agent.resume' }), row({ action: 'x' })]);
    // 検証は通り、見た件数も返る
    expect(verifyAuditChain(SECRET, rows, secretsEqual)).toEqual({ ok: true, checked: 3 });
  });

  it('空の連鎖は ok を返す (まだ 1 件も記録が無いテナント)', () => {
    // 行が無い状態
    expect(verifyAuditChain(SECRET, [], secretsEqual)).toEqual({ ok: true, checked: 0 });
  });

  it('改ざん検知: 値を書き換えた行は hash_mismatch で落ちる', () => {
    // 3 件の連鎖を作り、2 件目の操作名だけを書き換える (ハッシュは古いまま)
    const rows = chainOf(SECRET, [row(), row(), row()]);
    const tampered = rows.map((item) =>
      item.seq === 2n ? { ...item, action: 'agent.resume' } : item,
    );
    // 2 件目で落ちる
    expect(verifyAuditChain(SECRET, tampered, secretsEqual)).toEqual({
      ok: false,
      checked: 3,
      brokenSeq: 2n,
      reason: AuditChainBreak.hash_mismatch,
    });
  });

  it('改ざん検知: 途中の行を削除すると seq_not_sequential で落ちる', () => {
    // 3 件の連鎖から 2 件目を抜く
    const rows = chainOf(SECRET, [row(), row(), row()]);
    const removed = rows.filter((item) => item.seq !== 2n);
    // 2 件目の位置に来た 3 件目で落ちる (連番が 1 の次に 3 になっている)
    expect(verifyAuditChain(SECRET, removed, secretsEqual)).toEqual({
      ok: false,
      checked: 2,
      brokenSeq: 3n,
      reason: AuditChainBreak.seq_not_sequential,
    });
  });

  it('改ざん検知: 行を差し込むと prev_hash_mismatch で落ちる', () => {
    // 2 件の連鎖を作り、その間に「ハッシュ自体は正しいが prevHash が繋がっていない」行を挟む。
    // 差し込む側は自分の行のハッシュを正しく計算できる (鍵を持っていれば) が、
    // **後続の prevHash まで作り直さないと連鎖は繋がらない**
    const rows = chainOf(SECRET, [row(), row()]);
    const inserted: AuditChainRow = row({ seq: 2n, action: 'injected', prevHash: 'deadbeef' });
    const withInjection: StoredAuditRow[] = [
      rows[0]!,
      { ...inserted, hash: auditRowHash(SECRET, inserted) },
      { ...rows[1]!, seq: 3n },
    ];
    // 差し込んだ行で落ちる
    expect(verifyAuditChain(SECRET, withInjection, secretsEqual)).toEqual({
      ok: false,
      checked: 3,
      brokenSeq: 2n,
      reason: AuditChainBreak.prev_hash_mismatch,
    });
  });

  it('改ざん検知: 先頭の行の prevHash が null でなければ落ちる', () => {
    // 1 件だけの連鎖を作り、先頭の prevHash に値を入れる
    const rows = chainOf(SECRET, [row()]);
    const forged: StoredAuditRow[] = [{ ...rows[0]!, prevHash: 'deadbeef' }];
    // 先頭で落ちる (「前があったはず」の痕跡を消して作り直した形)
    expect(verifyAuditChain(SECRET, forged, secretsEqual)).toEqual({
      ok: false,
      checked: 1,
      brokenSeq: 1n,
      reason: AuditChainBreak.prev_hash_mismatch,
    });
  });

  it('改ざん検知: 別の鍵で作り直した連鎖は hash_mismatch で落ちる', () => {
    // 鍵を知らない相手が連鎖を作り直した形 (値もハッシュも整合しているが鍵が違う)
    const forged = chainOf(OTHER_SECRET, [row(), row()]);
    // 正しい鍵で検証すると先頭から落ちる
    expect(verifyAuditChain(SECRET, forged, secretsEqual)).toEqual({
      ok: false,
      checked: 2,
      brokenSeq: 1n,
      reason: AuditChainBreak.hash_mismatch,
    });
  });

  it('連番は直前が無ければ 1、あれば +1 になる', () => {
    // 最初の行
    expect(nextAuditSeq(null)).toBe(1n);
    // 2 件目以降
    expect(nextAuditSeq(41n)).toBe(42n);
  });
});

describe('監査ログの HMAC 鍵の読み出し', () => {
  it('下限を満たす鍵はそのまま返る (前後の空白は落とす)', () => {
    // 空白付きで渡しても中身が返る
    expect(auditHmacSecret(env({ [AUDIT_HMAC_SECRET_ENV]: `  ${SECRET}  ` }))).toBe(SECRET);
  });

  it('未設定・空・短すぎは 503 で落ちる (fail-closed)', () => {
    // 下限より 1 文字短い鍵
    const tooShort = 'a'.repeat(AUDIT_HMAC_SECRET_MIN_LENGTH - 1);
    // 3 つの壊れ方すべてで例外になる
    const broken = [{}, { [AUDIT_HMAC_SECRET_ENV]: '' }, { [AUDIT_HMAC_SECRET_ENV]: tooShort }];
    // 鍵が無いまま監査ログを書かせない (書けないなら操作自体を失敗させる)
    for (const values of broken) {
      expect(() => auditHmacSecret(env(values))).toThrowError(
        expect.objectContaining({ status: 503 }) as Error,
      );
    }
  });
});
