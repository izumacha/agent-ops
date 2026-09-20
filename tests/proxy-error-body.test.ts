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

  it('識別子として長すぎる値は通さない (自由記述が別名で入ってくる経路を塞ぐ)', () => {
    // code に長文を入れても落ちる
    const safe = sanitizeUpstreamErrorBody({ error: { code: 'x'.repeat(101) } });
    // 定型文だけが残る
    expect(safe).toEqual({ error: { message: API_MESSAGES.upstreamRejected } });
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
