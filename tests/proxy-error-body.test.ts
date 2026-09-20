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
    ['空文字', { type: '' }],
  ])('識別子の綴りに収まらない値は通さない: %s', (_label, error) => {
    // 長さだけを見ていたときは 100 文字以内の散文が素通しした (実測)
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
    ['ベンダーの種別', { type: 'invalid_request_error' }],
    ['ベンダーのコード', { code: 'context_length_exceeded' }],
    ['JSON パス形式の param', { param: 'messages[0].content' }],
    ['ハイフンとドット', { code: 'rate-limit.exceeded' }],
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
