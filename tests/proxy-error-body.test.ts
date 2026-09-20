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

  it('最上位の type に入れた散文も通さない', () => {
    // 最上位の type は Anthropic が 'error' を入れる項目。ここにも散文は入れられる
    const safe = sanitizeUpstreamErrorBody({
      type: 'org ACME Corp balance is $0.00 — upgrade at Plans & Billing',
      error: {},
    });
    // 最上位の type ごと落ちる
    expect(safe).toEqual({ error: { message: API_MESSAGES.upstreamRejected } });
  });

  it.each([
    ['ドットで繋いだ文 (type)', { type: 'billing.org_ACME_Corp.tier_enterprise' }],
    ['JSON パスの形 (code)', { code: 'messages[0].content' }],
  ])('param 用の綴りは type / code には効かない: %s', (_label, error) => {
    // **項目ごとに綴りを分けたことの中核**。1 本にまとめると param 用のドットと角括弧が
    // type / code にも効き、区切り文字で書いた文が素通りする。
    // 固定する前は、type を param 用のパターンへ差し替える変異が全件緑で通った (実測)
    expect(sanitizeUpstreamErrorBody({ error })).toEqual({
      error: { message: API_MESSAGES.upstreamRejected },
    });
  });

  it.each([
    // 語ごとの規則は満たすが総長が 1 文字だけ超える (先読みの上限だけを見る)
    ['総長を 1 超える (code)', { code: `${'a'.repeat(32)}_${'b'.repeat(8)}` }],
    ['総長を 1 超える (param)', { param: `a.${'b'.repeat(23)}.${'c'.repeat(23)}` }],
    // 総長には収まるが語数・階層が 1 つ多い。**散文を止めているのはこちら**で、
    // 総長だけでは枠内の英文 (`your_credit_balance_is_too_low` 30 文字) が通ってしまう (実測)
    ['語数を 1 超える (code)', { code: 'a_b_c_d_e' }],
    ['語数を 1 超える (type)', { type: 'a_b_c_d_e' }],
    ['階層を 1 超える (param)', { param: 'a.b.c.d.e.f.g' }],
    ['添字の階層を 1 超える (param)', { param: 'a[1][2][3][4][5][6]' }],
    ['添字の桁数を 1 超える (param)', { param: 'a[10000]' }],
    ['総長に収まる散文 (code)', { code: 'your_credit_balance_is_too_low' }],
    ['総長に収まる散文 (param)', { param: 'credit.balance.is.too.low.add.funds.now' }],
  ])('上限を 1 超えたら通さない: %s', (_label, error) => {
    // 上限を緩める変異を落とす。固定する前は語数・階層をいくら広げても全件緑だった (実測)
    expect(sanitizeUpstreamErrorBody({ error })).toEqual({
      error: { message: API_MESSAGES.upstreamRejected },
    });
  });

  it('最上位の type にも param 用の綴りは効かない', () => {
    // 最上位の type も分類語彙 (Anthropic は 'error') なので code と同じ綴りで絞る
    expect(
      sanitizeUpstreamErrorBody({ type: 'billing.org_ACME_Corp.tier_enterprise', error: {} }),
    ).toEqual({ error: { message: API_MESSAGES.upstreamRejected } });
  });

  it.each([
    ['総長ちょうどの語の連結 (code)', { code: `${'a'.repeat(32)}_${'b'.repeat(7)}` }, 'code'],
    [
      '総長ちょうどの JSON パス (param)',
      { param: `a.${'b'.repeat(23)}.${'c'.repeat(22)}` },
      'param',
    ],
    ['語数ちょうど (code)', { code: 'a_b_c_d' }, 'code'],
    ['階層ちょうど (param)', { param: 'a.b.c.d.e.f' }, 'param'],
    ['添字の階層ちょうど (param)', { param: 'a[1][2][3][4][5]' }, 'param'],
    ['4 桁の添字 (param)', { param: 'messages[1000].content' }, 'param'],
    ['総長ちょうどの 1 語 (code)', { code: 'a'.repeat(40) }, 'code'],
  ])('上限ちょうどは通す (絞りすぎて診断が消えていない): %s', (_label, error, field) => {
    // 上限の下側も見る。上側だけだと、上限をいくら広げても気付けない
    const safe = sanitizeUpstreamErrorBody({ error }) as { error: Record<string, unknown> };
    expect(safe.error[field]).toBe((error as Record<string, string>)[field]);
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
