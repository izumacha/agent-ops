// 受信 Webhook の署名検証（`src/lib/billing/signature.ts`）の境界。
//
// **ここが抜けると、誰でも任意のテナントのプランを enterprise へ上げられる。** 署名は唯一の
// 認証なので、固定するのは 4 系統:
//   1. 正しい署名を通すこと（緩すぎない検査は意味が無い）
//   2. 形・時刻・一致のどれが崩れても通さないこと（fail-closed）
//   3. **鍵のローテーション**（v1 が複数載る形）を扱えること
//   4. 鍵が未設定・短すぎなら 503（検証を飛ばして受け入れない）
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BILLING_SIGNATURE_TOLERANCE_SECONDS,
  BILLING_WEBHOOK_SECRET_ENV,
  billingWebhookSecret,
  parseBillingSignature,
  verifyBillingSignature,
} from '@/lib/billing/signature';
import { ApiError } from '@/lib/api/errors';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { BILLING_WEBHOOK_SECRET_MIN_LENGTH } from '@/lib/constants';

// 検査に使う共有シークレット（最小長を満たす固定値）
const SECRET = 'billing-test-secret-0123456789abcdef';
// 検査に使う本文（生のテキストであることが要点）
const PAYLOAD = '{"id":"evt_1","type":"customer.subscription.updated"}';
// 署名した時刻（UNIX 秒）
const T0 = 1_760_000_000;

// 正しい署名ヘッダを組み立てる
function signedHeader(timestamp = T0, payload = PAYLOAD, secret = SECRET): string {
  // 署名の対象は `<t>.<本文>`
  const signature = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

// 環境変数を組み立てる（NODE_ENV は ProcessEnv で必須）
function env(value: string | undefined): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', [BILLING_WEBHOOK_SECRET_ENV]: value } as NodeJS.ProcessEnv;
}

describe('署名ヘッダの分解', () => {
  it('t と v1 を読む', () => {
    // 正しい形
    const parsed = parseBillingSignature(signedHeader());
    expect(parsed?.timestamp).toBe(T0);
    expect(parsed?.signatures).toHaveLength(1);
  });

  it('v1 が複数載る形（鍵のローテーション中）も読む', () => {
    // 2 本の署名（どちらかが一致すれば通す形にしてある）
    const first = 'a'.repeat(64);
    const second = 'b'.repeat(64);
    const parsed = parseBillingSignature(`t=${T0},v1=${first},v1=${second}`);
    expect(parsed?.signatures).toEqual([first, second]);
  });

  it.each([
    ['ヘッダが無い', null],
    ['空', ''],
    ['t が無い', `v1=${'a'.repeat(64)}`],
    ['v1 が無い', `t=${T0}`],
    ['t が数値でない', `t=いま,v1=${'a'.repeat(64)}`],
    ['t が負数', `t=-1,v1=${'a'.repeat(64)}`],
    ['t が小数', `t=1.5,v1=${'a'.repeat(64)}`],
    ['v1 が 16 進でない', `t=${T0},v1=${'z'.repeat(64)}`],
    ['v1 が短い', `t=${T0},v1=${'a'.repeat(63)}`],
    ['v1 が長い', `t=${T0},v1=${'a'.repeat(65)}`],
    ['v1 が大文字の 16 進', `t=${T0},v1=${'A'.repeat(64)}`],
  ])('形が違えば読まない（fail-closed）: %s', (_label, header) => {
    // **寛容に読まない** — 読めなかったぶんを無視して進むと、壊れたヘッダが「検証を通った」に化ける
    expect(parseBillingSignature(header)).toBeNull();
  });

  it('長すぎるヘッダは読まない（正規表現を当てる前に縛る）', () => {
    // 署名を大量に並べた形（§9 の ReDoS 対策で長さの上限を置いてある）
    const many = Array.from({ length: 100 }, () => `v1=${'a'.repeat(64)}`).join(',');
    expect(parseBillingSignature(`t=${T0},${many}`)).toBeNull();
  });
});

describe('署名の検証', () => {
  it('正しい署名を通す', () => {
    // 同じ鍵・同じ本文・同じ時刻
    expect(verifyBillingSignature(signedHeader(), PAYLOAD, SECRET, T0)).toBe('ok');
  });

  it('許容幅の中なら時刻がずれていても通す', () => {
    // 幅のちょうど端（過去側・未来側の両方）
    const edge = BILLING_SIGNATURE_TOLERANCE_SECONDS;
    expect(verifyBillingSignature(signedHeader(), PAYLOAD, SECRET, T0 + edge)).toBe('ok');
    expect(verifyBillingSignature(signedHeader(), PAYLOAD, SECRET, T0 - edge)).toBe('ok');
  });

  it('許容幅を超えた時刻は通さない（リプレイ防止）', () => {
    // **これが無いと、1 度盗んだ署名付きの本文を何年後でも再生できる**
    const over = BILLING_SIGNATURE_TOLERANCE_SECONDS + 1;
    expect(verifyBillingSignature(signedHeader(), PAYLOAD, SECRET, T0 + over)).toBe('stale');
    // **未来側も縛る** — 時計を進めて作った署名が幅の分だけ長く有効になるのを防ぐ
    expect(verifyBillingSignature(signedHeader(), PAYLOAD, SECRET, T0 - over)).toBe('stale');
  });

  it('本文が 1 文字でも違えば通さない', () => {
    // 署名の対象は本文そのままなので、改変は必ず不一致になる
    expect(verifyBillingSignature(signedHeader(), `${PAYLOAD} `, SECRET, T0)).toBe('mismatch');
  });

  it('鍵が違えば通さない', () => {
    // 別の鍵で作った署名
    const other = `${SECRET}-other`;
    expect(verifyBillingSignature(signedHeader(T0, PAYLOAD, other), PAYLOAD, SECRET, T0)).toBe(
      'mismatch',
    );
  });

  it('時刻を書き換えた署名は通さない（t も署名の対象に入っている）', () => {
    // 正しい署名の t だけを差し替える（t が対象に入っていなければここが通ってしまう）
    const header = signedHeader();
    const tampered = header.replace(`t=${T0}`, `t=${T0 + 1}`);
    expect(verifyBillingSignature(tampered, PAYLOAD, SECRET, T0 + 1)).toBe('mismatch');
  });

  it('鍵のローテーション中は新旧どちらの署名でも通す', () => {
    // 旧鍵の署名と新鍵の署名が並んで載る形（新鍵で検証する側）
    const old = createHmac('sha256', `${SECRET}-old`).update(`${T0}.${PAYLOAD}`).digest('hex');
    const current = createHmac('sha256', SECRET).update(`${T0}.${PAYLOAD}`).digest('hex');
    expect(verifyBillingSignature(`t=${T0},v1=${old},v1=${current}`, PAYLOAD, SECRET, T0)).toBe(
      'ok',
    );
  });

  it('形が読めないヘッダは malformed（通さない）', () => {
    // 署名が無い要求（= 誰でも叩ける経路に認証が無い状態）
    expect(verifyBillingSignature(null, PAYLOAD, SECRET, T0)).toBe('malformed');
  });
});

describe('共有シークレットの読み取り', () => {
  it('設定されていれば前後の空白を落として返す', () => {
    // 貼り付けの改行で長さ判定が狂わないこと
    expect(billingWebhookSecret(env(`  ${SECRET}  `))).toBe(SECRET);
  });

  it.each([
    ['未設定', undefined],
    ['空', ''],
    ['空白だけ', '   '],
    ['短すぎる', 'a'.repeat(BILLING_WEBHOOK_SECRET_MIN_LENGTH - 1)],
  ])('使えない鍵は 503 で落とす（fail-closed）: %s', (_label, value) => {
    // **「鍵が無いときは検証せずに受け入れる」は採らない** — プランを書き換える経路なので、
    // 検証を飛ばすと誰でも任意のテナントを enterprise へ上げられる
    try {
      billingWebhookSecret(env(value));
      expect.unreachable('使えない鍵で通ってしまった');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
    }
  });

  it('最小長ちょうどは通す（境界で 1 文字厳しくしない）', () => {
    // 境界の値
    const exact = 'a'.repeat(BILLING_WEBHOOK_SECRET_MIN_LENGTH);
    expect(billingWebhookSecret(env(exact))).toBe(exact);
  });
});
