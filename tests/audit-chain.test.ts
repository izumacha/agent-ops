// 監査ログのハッシュ連鎖 (src/domain/audit/chain.ts) と鍵の読み出し (src/lib/audit/secret.ts) の検査。
// DB を触らない純粋ロジックなので、境界をここで全部固定する (§11)。
// **改ざん検知が「実際に検知する」ことの検査は 3 種類の壊れ方ごとに書く** —
// 1 種類だけ見ていると、他の壊れ方を素通りさせる実装でも緑になる
import { describe, expect, it } from 'vitest';
import {
  AuditChainBreak,
  auditRowHash,
  isAuditPayload,
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
// 検査で使うテナント (row() の既定と verifyAuditChain に渡す値を揃える)
const TENANT = 't1';
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
    id: 'audit-1',
    tenantId: TENANT,
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
      id: `audit-${index + 1}`,
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
      { id: 'audit-other' },
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
    expect(verifyAuditChain(SECRET, TENANT, rows, secretsEqual)).toEqual({ ok: true, verified: 3 });
  });

  it('空の連鎖は ok を返す (まだ 1 件も記録が無いテナント)', () => {
    // 行が無い状態
    expect(verifyAuditChain(SECRET, TENANT, [], secretsEqual)).toEqual({ ok: true, verified: 0 });
  });

  it('改ざん検知: 値を書き換えた行は hash_mismatch で落ちる', () => {
    // 3 件の連鎖を作り、2 件目の操作名だけを書き換える (ハッシュは古いまま)
    const rows = chainOf(SECRET, [row(), row(), row()]);
    const tampered = rows.map((item) =>
      item.seq === 2n ? { ...item, action: 'agent.resume' } : item,
    );
    // 2 件目で落ちる
    expect(verifyAuditChain(SECRET, TENANT, tampered, secretsEqual)).toEqual({
      ok: false,
      verified: 1,
      brokenSeq: 2n,
      reason: AuditChainBreak.hash_mismatch,
    });
  });

  it('改ざん検知: 途中の行を削除すると seq_not_sequential で落ちる', () => {
    // 3 件の連鎖から 2 件目を抜く
    const rows = chainOf(SECRET, [row(), row(), row()]);
    const removed = rows.filter((item) => item.seq !== 2n);
    // 2 件目の位置に来た 3 件目で落ちる (連番が 1 の次に 3 になっている)
    expect(verifyAuditChain(SECRET, TENANT, removed, secretsEqual)).toEqual({
      ok: false,
      verified: 1,
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
    expect(verifyAuditChain(SECRET, TENANT, withInjection, secretsEqual)).toEqual({
      ok: false,
      verified: 1,
      brokenSeq: 2n,
      reason: AuditChainBreak.prev_hash_mismatch,
    });
  });

  it('改ざん検知: 先頭の行の prevHash が null でなければ落ちる', () => {
    // 1 件だけの連鎖を作り、先頭の prevHash に値を入れる
    const rows = chainOf(SECRET, [row()]);
    const forged: StoredAuditRow[] = [{ ...rows[0]!, prevHash: 'deadbeef' }];
    // 先頭で落ちる (「前があったはず」の痕跡を消して作り直した形)
    expect(verifyAuditChain(SECRET, TENANT, forged, secretsEqual)).toEqual({
      ok: false,
      verified: 0,
      brokenSeq: 1n,
      reason: AuditChainBreak.prev_hash_mismatch,
    });
  });

  it('改ざん検知: 別の鍵で作り直した連鎖は hash_mismatch で落ちる', () => {
    // 鍵を知らない相手が連鎖を作り直した形 (値もハッシュも整合しているが鍵が違う)
    const forged = chainOf(OTHER_SECRET, [row(), row()]);
    // 正しい鍵で検証すると先頭から落ちる
    expect(verifyAuditChain(SECRET, TENANT, forged, secretsEqual)).toEqual({
      ok: false,
      verified: 0,
      brokenSeq: 1n,
      reason: AuditChainBreak.hash_mismatch,
    });
  });

  it('改ざん検知: 別テナントの行が混ざっていたら tenant_mismatch で落ちる', () => {
    // t1 の連鎖を作り、検証だけ t2 に対して行う。
    // **この経路が無いと偽の合格が成立する** — 取り出すクエリのテナント条件が壊れて
    // 「t2 の監査ログ」として t1 の行が返ったとき、行に載っている tenantId を信じるだけだと
    // 連鎖は端から端まで整合しているので ok を返し、t2 は 1 行も見ていないのに「無傷」と報告される
    const rows = chainOf(SECRET, [row(), row()]);
    // 別テナントとして検証すると先頭で落ちる
    expect(verifyAuditChain(SECRET, 't2', rows, secretsEqual)).toEqual({
      ok: false,
      verified: 0,
      brokenSeq: 1n,
      reason: AuditChainBreak.tenant_mismatch,
    });
  });

  it('改ざん検知: 正規化できない payload は payload_not_canonical で落ちる', () => {
    // 入れ子の payload を持つ行を作る (DB の列は Json なので、型注釈をすり抜けて入りうる)
    const rows = chainOf(SECRET, [row()]);
    const nested: StoredAuditRow = { ...rows[0]!, payload: { detail: { b: 2, a: 1 } } };
    // ハッシュを再計算できないので「検証できない行」として落とす
    // (素通しすると JSONB の内部順序に依存してハッシュが揺れ、誰も触っていない行が不定に赤くなる)
    expect(verifyAuditChain(SECRET, TENANT, [nested], secretsEqual)).toEqual({
      ok: false,
      verified: 0,
      brokenSeq: 1n,
      reason: AuditChainBreak.payload_not_canonical,
    });
  });

  it('verified は壊れた行の手前まで (渡した件数ではない)', () => {
    // 5 件の連鎖を作り、4 件目を書き換える
    const rows = chainOf(SECRET, [row(), row(), row(), row(), row()]);
    const tampered = rows.map((item) => (item.seq === 4n ? { ...item, action: 'x' } : item));
    // 確かめ終えたのは 3 件。**渡した 5 件を返すと「5 件すべて確かめた」と誤読される**
    // (実際には 5 件目は 1 度も見ていない)
    expect(verifyAuditChain(SECRET, TENANT, tampered, secretsEqual)).toMatchObject({
      ok: false,
      verified: 3,
      brokenSeq: 4n,
    });
  });

  it('連番は直前が無ければ 1、あれば +1 になる', () => {
    // 最初の行
    expect(nextAuditSeq(null)).toBe(1n);
    // 2 件目以降
    expect(nextAuditSeq(41n)).toBe(42n);
  });
});

describe('payload の形の実行時検査', () => {
  it('平坦な原始値だけの辞書を受け付ける', () => {
    // 文字列・数値・真偽値・null はすべて許す
    expect(isAuditPayload({ a: 'x', b: 1, c: true, d: null })).toBe(true);
    // 空の辞書も平坦
    expect(isAuditPayload({})).toBe(true);
  });

  it('入れ子・配列・辞書以外を拒否する', () => {
    // **型注釈では守れないので実行時に見る** (DB の列は Json で、読み出した値は型の保証が無い)
    for (const broken of [
      { a: { b: 1 } }, // 入れ子の辞書
      { a: [1, 2] }, // 配列の値
      [1, 2], // 配列そのもの
      null, // null
      'text', // 文字列
      42, // 数値
      { a: undefined }, // undefined (JSON.stringify が配列内で null に化けるので null と区別できない)
    ]) {
      expect(isAuditPayload(broken)).toBe(false);
    }
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

describe('監査ログを書く前の設定の確認', () => {
  it('鍵が読めるかだけを確かめ、読めなければ 503 を投げる', async () => {
    // **人の操作では状態を変える前にこれを呼ぶ。** 変えてから記録に失敗すると、記録の無い
    // 変更が残り、しかも再試行は「既にその状態だ」で永久に失敗する（実測で resolve がそうだった）
    const { assertAuditConfigured } = await import('@/lib/audit/record');
    // 下限を満たす鍵なら何も起きない（値は返さない。読めることだけを確かめる関数）
    expect(assertAuditConfigured(env({ [AUDIT_HMAC_SECRET_ENV]: SECRET }))).toBeUndefined();
    // 未設定なら 503
    expect(() => assertAuditConfigured(env({}))).toThrowError(
      expect.objectContaining({ status: 503 }) as Error,
    );
  });
});

describe('監査ログの payload の実行時検査', () => {
  it('入れ子の payload は追記の入口で止める（ハッシュが不定に揺れる形を保存させない）', async () => {
    // **列の型は `Json?` なので型注釈では守れない。** 入れ子が混ざると正規化がその階層を
    // 並べ替えないため、JSONB の内部順序に依存してハッシュが揺れ、**保存して読み直しただけで
    // 検証に失敗しうる**。追記してからでは直せない（追記専用なので行を消せない）ので入口で落とす
    const { recordAudit } = await import('@/lib/audit/record');
    // 追記が呼ばれたら分かるようにしておく（呼ばれてはいけない）
    let appended = 0;
    // 必要な Port だけを持つ最小の偽物（他のメソッドはこのテストでは呼ばれない）
    const repos = {
      auditLogs: {
        append: async () => {
          appended += 1;
          throw new Error('追記されてはいけない');
        },
      },
    } as unknown as Parameters<typeof recordAudit>[0];
    // 入れ子を持つ payload で呼ぶ（型注釈は通ってしまうので any ではなく cast で作る）
    await expect(
      recordAudit(
        repos,
        {
          tenantId: TENANT,
          actorId: null,
          action: 'guardrail.fired' as never,
          targetType: 'Incident' as never,
          // 平坦でない payload（`isAuditPayload` が false を返す形）
          targetId: 'inc_1',
          payload: { nested: { deep: 1 } } as never,
        },
        env({ [AUDIT_HMAC_SECRET_ENV]: SECRET }),
      ),
    ).rejects.toThrowError(expect.objectContaining({ status: 500 }) as Error);
    // 1 度も追記していないこと（「書いてから気付く」形にしない）
    expect(appended).toBe(0);
  });
});
