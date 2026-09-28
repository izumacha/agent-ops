// `describeError` の挙動契約。**この関数が唯一の経路**なので、ここが緩むと全ログ経路が同時に緩む。
// 以前は担保が `tests/api/health.test.ts` の間接 1 件しかなく、実測で
// `return { type: typeof error }` に `value: String(error)` を足す変異が 842 件すべて緑を通った
import { describe, expect, it } from 'vitest';
import { describeError } from '@/lib/describe-error';

describe('describeError', () => {
  it('Error でない値は型だけを返す (値そのものを載せない)', () => {
    // 文字列を throw する経路（任意の値がそのままログへ出ないこと）
    expect(describeError('postgres://app:secret@db')).toEqual({ type: 'string' });
    // オブジェクトも同じ
    expect(describeError({ dsn: 'postgres://app:secret@db' })).toEqual({ type: 'object' });
    // null / undefined / 数値
    expect(describeError(null)).toEqual({ type: 'object' });
    expect(describeError(undefined)).toEqual({ type: 'undefined' });
    expect(describeError(42)).toEqual({ type: 'number' });
  });

  it('message は 1 文字も含めない (PII とクエリ引数の本体)', () => {
    // ORM の検証エラーを模した message（利用者の入力がそのまま埋まる形）
    const error = new Error("Invalid `prisma.user.findUnique()`: email='tanaka@example.com'");
    // 出力を文字列にして探す（どの項目に紛れても気付けるように）
    const dumped = JSON.stringify(describeError(error));
    expect(dumped).not.toContain('tanaka@example.com');
    expect(dumped).not.toContain('prisma.user.findUnique');
  });

  it('name と code は短い識別子のときだけ中身を載せる', () => {
    // 実在の形（Node のシステムエラー）はそのまま載る
    const system = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    expect(describeError(system)).toMatchObject({ name: 'Error', code: 'ECONNREFUSED' });
    // **PostgreSQL の SQLSTATE は数字で始まる** — 英字始まりに絞ると診断が丸ごと消える
    for (const code of ['28P01', '23505', '42P01', 'P2002', 'ERR_INVALID_ARG_TYPE']) {
      const withCode = Object.assign(new Error('boom'), { code });
      expect(describeError(withCode), `${code} の診断が消えている`).toMatchObject({ code });
    }
    // **区切り記号を持たない秘密は長さで落とす** — 上限を根拠の無い 64 にしていた版は、
    // このリポジトリの API キーの形（`aop_k_` + 40 文字 = 46 文字）もそのまま載せた（実測）。
    // **残る境界**: 実在の例外名の最長は 38 文字（Bedrock の
    // `ProvisionedThroughputExceededException`）なので、それ以下の長さで区切り記号を
    // 持たない秘密（決済サービスの本番キーのような、接頭辞つき 32 文字程度のもの）は
    // **形でも長さでも区別できない**。ここを締めると実在の診断が消えるので締めない
    // （絞りすぎて診断が消えるのは、このリポジトリが繰り返し避けている失敗）。
    // **秘密に見える綴りをコミットに置かない**ので、ここでは実例を書かず形だけを述べる
    // （架空の値でも GitHub の push protection が実在の鍵として弾く。§9）
    for (const secret of [`aop_k_${'a'.repeat(40)}`, 'A'.repeat(64)]) {
      const withSecret = Object.assign(new Error('boom'), { code: secret });
      expect(describeError(withSecret), `${secret.slice(0, 12)}… が載っている`).toMatchObject({
        code: { type: 'string' },
      });
    }
    // 接続文字列を code に入れた形は中身を出さない
    const dsn = Object.assign(new Error('boom'), { code: 'postgres://app:secret-pw@db' });
    expect(describeError(dsn)).toMatchObject({ code: { type: 'string' } });
    // 構造化された診断を code に入れた形も型だけ
    const structured = Object.assign(new Error('boom'), {
      code: { q: "SELECT * FROM users WHERE email='tanaka@example.com'" },
    });
    expect(JSON.stringify(describeError(structured))).not.toContain('tanaka@example.com');
    // name は書き換えられるので同じ規則で絞る
    const renamed = new Error('boom');
    renamed.name = 'tanaka@example.com';
    expect(describeError(renamed)).toMatchObject({ name: { type: 'string' } });
  });

  it('message 由来の行をスタックフレームとして載せない', () => {
    // message に偽のフレームを仕込む（改行を含む利用者の入力を模す）
    const error = new Error('boom\n    at 田中 (/etc/passwd:1:1)');
    // 見出しは name + message で固定されるので、長さで切り落とせる
    const frames = describeError(error).frames as string[];
    expect(frames.some((frame) => frame.includes('田中'))).toBe(false);
    // 本物のフレームは残っている（絞りすぎて診断が消えていないこと）
    expect(frames.length).toBeGreaterThan(0);
  });

  it('stack を固定した後で message を差し替えても、message 由来の行を載せない', () => {
    // V8 は `error.stack` を初回アクセスで文字列に固定する
    const error = new Error('boom\n    at MARKER_ONE:1:1');
    void error.stack;
    // そのあと message を差し替えると、`name: message` の見出し候補が外れる
    error.message = 'sanitized';
    // 素の `name` が前方一致して見出しに採用されると、残りは `": <元の message>…"` になり、
    // message の中のフレームの形の行が frames に載っていた（実測）。
    // 見出しの直後が改行であることまで求めれば、この形は fail-closed に倒れる
    const described = describeError(error);
    expect(described.frames).toEqual([]);
    expect(described.stackUnparsed).toBe(true);
  });

  it('見出しを読めなければフレームを 1 行も出さず、その事実を残す (fail-closed)', () => {
    // stack を差し替えて見出しと合わない形にする
    const error = new Error('boom');
    error.stack = 'まったく別の見出し\n    at 田中 (/etc/passwd:1:1)';
    // 読めなかったことが分かる印が付き、フレームは空
    expect(describeError(error)).toMatchObject({ frames: [], stackUnparsed: true });
  });

  it.each(['cause', 'code', 'name'])('読むと投げる %s があっても throw しない', (property) => {
    // **ログ整形器が throw すると到達先ごとに壊れ方が違う** — `route()` の catch の中なら
    // 統一された 500 応答をすり抜け、`onPoolError` の中なら uncaught でプロセスが落ち、
    // 上流の失敗の経路なら 502/504 が 500 に化けて台帳の statusCode まで変わる
    const error = new Error('boom');
    Object.defineProperty(error, property, {
      get() {
        throw new Error('読むと投げる');
      },
    });
    // 投げずに「読めなかった」ことだけを返す
    expect(describeError(error)).toEqual({ type: 'object', undescribable: true });
  });

  it('cause.name が読むと投げても throw しない', () => {
    // 1 段たどった先のプロパティでも同じ
    const inner = new Error('inner');
    Object.defineProperty(inner, 'name', {
      get() {
        throw new Error('読むと投げる');
      },
    });
    const outer = new Error('boom', { cause: inner });
    expect(describeError(outer)).toEqual({ type: 'object', undescribable: true });
  });

  it('cause は name / code だけを 1 段たどり、message は載せない', () => {
    // cause に PII 入りの message と、実在の形の code を持つ Error を繋ぐ
    const inner = Object.assign(new Error('email=tanaka@example.com'), { code: 'ECONNREFUSED' });
    const outer = new Error('fetch failed', { cause: inner });
    const described = describeError(outer);
    // **message は 1 文字も出ない**
    expect(JSON.stringify(described)).not.toContain('tanaka@example.com');
    // **理由は残る** — undici は接続不能も証明書エラーも `TypeError: fetch failed` で包むので、
    // 辿らないと実際の理由が消え、502 / 504 のログが「TypeError」だけになる
    expect(described.cause).toEqual({ name: 'Error', code: 'ECONNREFUSED' });
    // 2 段目は辿らない（連鎖をいくらでも辿ると規則が緩む）
    const nested = new Error('outer', { cause: new Error('mid', { cause: inner }) });
    expect(JSON.stringify(describeError(nested))).not.toContain('tanaka@example.com');
    // AggregateError の errors は辿らない
    const aggregate = new AggregateError([inner], 'boom');
    expect(JSON.stringify(describeError(aggregate))).not.toContain('tanaka@example.com');
  });
});
