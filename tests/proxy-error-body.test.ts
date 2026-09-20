// 上流のエラー本文の絞り込み (src/lib/proxy/error-body.ts)。
// ここが緩むと、上流アカウントの残高・組織名・契約ティアが有効な API キーを持つ全テナントへ漏れる
import { describe, expect, it } from 'vitest';
import { sanitizeUpstreamErrorBody } from '@/lib/proxy/error-body';
import { API_MESSAGES } from '@/lib/constants';

describe('上流のエラー本文の絞り込み', () => {
  it('機械可読な項目だけを残し、自由記述は定型文へ差し替える', () => {
    // OpenAI 形式のエラー本文 (message に組織名が載る実例)
    const safe = sanitizeUpstreamErrorBody({
      error: {
        type: 'invalid_request_error',
        code: 'model_not_found',
        param: 'model',
        message: 'your organization acme-corp does not have access to it',
      },
    });
    // 識別子は残る
    expect(safe).toEqual({
      error: {
        message: API_MESSAGES.upstreamRejected,
        type: 'invalid_request_error',
        code: 'model_not_found',
        param: 'model',
      },
    });
  });

  it('許可リストに無い項目は落とす (上流の識別子や入れ子も含む)', () => {
    // request_id や独自の項目、入れ子のオブジェクトは残さない
    const safe = sanitizeUpstreamErrorBody({
      type: 'error',
      request_id: 'req_011CQabcdef',
      error: {
        type: 'invalid_request_error',
        billing: { balance_usd: 0.12, organization: 'acme-corp' },
        detail: 'credit balance is too low',
        // detail は許可リストに無いので、綴りによらず落ちる
      },
    });
    // 最上位の type と error.type だけが残る
    expect(safe).toEqual({
      type: 'error',
      error: { message: API_MESSAGES.upstreamRejected, type: 'invalid_request_error' },
    });
    // 落とした値がどこにも残っていない
    expect(JSON.stringify(safe)).not.toContain('acme-corp');
    expect(JSON.stringify(safe)).not.toContain('req_011CQabcdef');
  });

  it.each([
    ['空白入りの散文 (code)', { code: 'quota for org-ACME exhausted; plan=Enterprise' }],
    [
      '空白入りの散文 (param)',
      { param: 'organization ACME Corp (tier: enterprise) has no access' },
    ],
    ['長すぎる識別子', { code: 'x'.repeat(65) }],
    ['制御文字を含む値', { code: 'a\r\nX-Injected: 1\u0000b' }],
    ['孤立サロゲート', { code: '\ud800' }],
  ])('識別子の綴りに収まらない値は通さない: %s', (_label, error) => {
    // 長さだけを見ていたときは 100 文字以内の散文が素通しした (実測)
    const safe = sanitizeUpstreamErrorBody({ error });
    // 定型文だけが残る
    expect(safe).toEqual({ error: { message: API_MESSAGES.upstreamRejected } });
  });

  it.each([
    ['ドットとハイフンで繋いだ文 (code)', { code: 'billing.org-ACME_Corp.tier-enterprise' }],
    ['ハイフン区切りの文 (type)', { type: 'org-ACME.tier-enterprise.balance-0' }],
    [
      '長い語を繋いだ文 (param)',
      { param: 'credit_balance_too_low.add_funds_at_Plans_and_Billing' },
    ],
    ['キーの断片', { code: 'sk-proj-AbCdEf0123456789_XYZ.truncated_key_prefix' }],
    ['5 語以上の snake_case', { code: 'organization_ACME_tier_enterprise_has_no_access' }],
  ])('区切り文字で書いた文も通さない: %s', (_label, error) => {
    // **空白が無いだけでは足りない** — 空白は `_` や `.` で置き換えられる。
    // 1 本の正規表現に `.` と `-` をまとめて許していたときは、これらが全部素通りした (実測)
    const safe = sanitizeUpstreamErrorBody({ error });
    // 定型文だけが残る
    expect(safe).toEqual({ error: { message: API_MESSAGES.upstreamRejected } });
  });

  // **同じ綴りを使う出力位置をすべて総当たりする。**
  // `SAFE_CODE_PATTERN` を参照する箇所は 3 つある (`error.type` / `error.code` / 最上位 `type`)。
  // 項目を 1 つ選んで検査すると、**別の箇所だけを差し替える変異が素通りする** —— 実測で、
  // 語数の上限を最上位 `type` だけ緩める変異は 618 件すべて緑のまま通り、テスト件数も変わらなかった。
  // 「同じ定数を指しているから 1 つ見れば足りる」は実装の都合であって契約ではない
  const CODE_POSITIONS = ['error.type', 'error.code', '最上位 type'] as const;
  // 検査したい位置へ値を載せた「上流の本文」を組み立てる
  function upstreamBodyWith(position: (typeof CODE_POSITIONS)[number], value: string): unknown {
    // error.type に載せる
    if (position === 'error.type') return { error: { type: value } };
    // error.code に載せる
    if (position === 'error.code') return { error: { code: value } };
    // 最上位の type に載せる (Anthropic が 'error' を入れる項目)
    return { type: value, error: {} };
  }
  // 通ったとき、その値が応答のどこへ出るかを読む
  function relayedValue(
    position: (typeof CODE_POSITIONS)[number],
    safe: Record<string, unknown>,
  ): unknown {
    // error オブジェクト (無ければ undefined)
    const error = safe.error as Record<string, unknown> | undefined;
    // 位置に応じて読む場所を変える
    if (position === 'error.type') return error?.type;
    if (position === 'error.code') return error?.code;
    return safe.type;
  }
  // 位置ごとの検査ケースへ展開する (ラベルに位置を入れて、どこで落ちたか分かるようにする)
  function forEachPosition(
    cases: readonly (readonly [string, string])[],
  ): readonly (readonly [string, (typeof CODE_POSITIONS)[number], string])[] {
    // 値 × 位置の総当たり
    return cases.flatMap(([label, value]) =>
      CODE_POSITIONS.map((position) => [`${label} @ ${position}`, position, value] as const),
    );
  }

  it.each(
    forEachPosition([
      // 語ごとの規則は満たすが総長が 1 文字だけ超える (先読みの上限だけを見る)
      ['総長を 1 超える', `${'a'.repeat(32)}_${'b'.repeat(8)}`],
      // 総長には収まるが語数が 1 つ多い。**分類語彙で散文を止めている主役はこちら**で、
      // 総長だけでは枠内の英文 (`your_credit_balance_is_too_low` 30 文字) が通ってしまう (実測)
      ['語数を 1 超える', 'a_b_c_d_e'],
      // 先頭語を除く語の長さ (16) の境界
      ['語の長さを 1 超える', `a_${'b'.repeat(17)}`],
      // 上の 2 つが効いていることを、実際に漏れて困る形でも見る
      ['総長に収まる散文', 'your_credit_balance_is_too_low'],
      // **項目ごとに綴りを分けたことの中核**。1 本にまとめると param 用のドットと角括弧が
      // 分類語彙にも効き、区切り文字で書いた文が素通りする (固定する前は変異が全件緑で通った)
      ['ドットで繋いだ文', 'billing.org_ACME_Corp.tier_enterprise'],
      ['JSON パスの形', 'messages[0].content'],
      // 空白を含む散文 (上流の message をそのまま入れてきた場合)
      ['空白を含む散文', 'org ACME Corp balance is $0.00 — upgrade at Plans & Billing'],
      // **文字クラス (どの字を語に使えるか) も固定する。** 上の表はどれも `.` を含むので、
      // 分類語彙はドットだけで落ちており、ハイフンや先頭の字種が一度も試されていなかった
      // (実測: 語の中へ `-` を入れる / 区切りを `[_-]` にする / 先頭に `_` を許す、の 3 変異が
      // いずれも全件緑で通った)。区切りが語に数えられない形は、この commit が `_` について
      // 塞いだ退行とまったく同型
      ['ハイフンで繋いだ文', 'org-ACME-Corp-tier-enterprise-balance-0'],
      ['ハイフン 4 語', 'org-ACME-tier-enterprise'],
      ['先頭のアンダースコア', '_billing_hard_limit_reached'],
    ]),
  )('分類語彙の上限を超えたら通さない: %s', (_label, position, value) => {
    // 上限を緩める変異を落とす。固定する前は語数をいくら広げても全件緑だった (実測)
    expect(sanitizeUpstreamErrorBody(upstreamBodyWith(position, value))).toEqual({
      error: { message: API_MESSAGES.upstreamRejected },
    });
  });

  it.each(
    forEachPosition([
      ['総長ちょうどの語の連結', `${'a'.repeat(32)}_${'b'.repeat(7)}`],
      ['語数ちょうど', 'a_b_c_d'],
      ['語の長さちょうど', `a_${'b'.repeat(16)}`],
      ['総長ちょうどの 1 語', 'a'.repeat(40)],
    ]),
  )(
    '分類語彙の上限ちょうどは通す (絞りすぎて診断が消えていない): %s',
    (_label, position, value) => {
      // 上限の下側も見る。上側だけだと、上限をいくら広げても気付けない
      const safe = sanitizeUpstreamErrorBody(upstreamBodyWith(position, value)) as Record<
        string,
        unknown
      >;
      expect(relayedValue(position, safe)).toBe(value);
    },
  );

  it.each([
    // param は綴りが違う (ドットと角括弧を許す) ので、別の表で上下を固定する
    ['総長を 1 超える', `a.${'b'.repeat(23)}.${'c'.repeat(23)}`],
    ['階層を 1 超える', 'a.b.c.d.e.f.g'],
    ['添字の階層を 1 超える', 'a[1][2][3][4][5][6]'],
    ['添字の桁数を 1 超える', 'a[10000]'],
    ['語の長さを 1 超える', `a_${'b'.repeat(17)}`],
    ['階層で繋いだ散文', 'credit.balance.is.too.low.add.funds.now'],
    // **param のアンダースコア散文**。param 用の綴りを別に書いていたとき、文字クラスが `_` を
    // トークンの内側に含んでいたため語数の上限が `_` を数えず、これらがそのまま中継された (実測)
    ['アンダースコア散文', 'your_credit_balance_is_too_low'],
    ['長いアンダースコア散文', 'credit_balance_too_low_go_to_Plans_and_Billing'],
    ['アンダースコアで繋いだキー形', 'sk_ant_api03_AAAABBBBCCCCDDDDEEEEFFFFGGGG'],
    // param 側の文字クラス。添字は階層 1 つぶんとしか数えないので、字種を緩めると
    // 「語数の枠外に自由な文字が乗る」形になる (実測: 添字を `[0-9A-Za-z]` にすると全件緑で通った)
    ['ハイフンで繋いだ文', 'your-credit-balance-is-too-low'],
    ['先頭のアンダースコア', '_credit.balance'],
    ['添字に数字以外', 'org[ACME][Corp][tier][ent]'],
  ])('JSON パスの上限を超えたら通さない: %s', (_label, param) => {
    // param 側の上限も 1 つずつ上から押さえる
    expect(sanitizeUpstreamErrorBody({ error: { param } })).toEqual({
      error: { message: API_MESSAGES.upstreamRejected },
    });
  });

  it.each([
    ['総長ちょうどの JSON パス', `a.${'b'.repeat(23)}.${'c'.repeat(22)}`],
    ['階層ちょうど', 'a.b.c.d.e.f'],
    ['添字の階層ちょうど', 'a[1][2][3][4][5]'],
    ['4 桁の添字ちょうど', 'a[9999]'],
    ['語数ちょうど', 'a_b_c_d'],
    ['語の長さちょうど', `a_${'b'.repeat(16)}`],
  ])('JSON パスの上限ちょうどは通す (絞りすぎて診断が消えていない): %s', (_label, param) => {
    // param 側の下側。実在の JSON パスを落としていないことを見る
    const safe = sanitizeUpstreamErrorBody({ error: { param } }) as {
      error: Record<string, unknown>;
    };
    expect(safe.error.param).toBe(param);
  });

  it.each([
    ['ベンダーの種別', { type: 'invalid_request_error' }],
    ['ベンダーのコード', { code: 'context_length_exceeded' }],
    ['JSON パス形式の param', { param: 'messages[0].content' }],
    ['4 語までの snake_case', { code: 'billing_hard_limit_reached' }],
    ['PascalCase (Azure)', { type: 'OperationNotSupported' }],
    ['長い PascalCase (Azure の innererror.code)', { code: 'ResponsibleAIPolicyViolation' }],
    ['長い PascalCase (Bedrock)', { code: 'ServiceQuotaExceededException' }],
    ['最も長い 1 語 (Bedrock)', { code: 'ProvisionedThroughputExceededException' }],
    ['長い 1 語 (Azure の Content Filter)', { code: 'ContentFilterResultsPolicyViolation' }],
    ['4 語の snake_case', { code: 'unsupported_country_region_territory' }],
    ['入れ子の添字つき JSON パス', { param: 'messages[0].content[1].text' }],
    ['4 桁の添字', { param: 'messages[1000].content' }],
    ['入れ子の JSON パス', { param: 'tools[12].input_schema.properties' }],
  ])('実在するベンダーの識別子は通す: %s', (_label, error) => {
    // 絞りすぎて診断が消えていないことを確かめる (綴りの条件が厳しすぎると全部 undefined になる)
    const safe = sanitizeUpstreamErrorBody({ error }) as { error: Record<string, unknown> };
    // 入れた項目がそのまま残る
    for (const [key, value] of Object.entries(error)) expect(safe.error[key]).toBe(value);
  });

  it.each([
    ['文字列でない値', { error: { type: 42, code: null, param: ['a'] } }],
    ['空文字', { error: { type: '' } }],
    ['error がオブジェクトでない', { error: 'boom' }],
    ['error が配列', { error: ['boom'] }],
    ['本文がオブジェクトでない', 'boom'],
    ['本文が null (JSON としては読めた)', null],
    ['本文が配列', [{ error: { type: 'x' } }]],
  ])('%s でも定型文だけを返す (fail-closed)', (_label, parsed) => {
    // 読めない形は素通しせず、定型文だけにする
    expect(sanitizeUpstreamErrorBody(parsed)).toEqual({
      error: { message: API_MESSAGES.upstreamRejected },
    });
  });
});
