// ダッシュボードの書き込み操作を守る CSRF 対策 (Step5 / ADR-0011) の検査。
// 「通してはいけない組み合わせ」を 1 つずつ固定する。
import { describe, expect, it } from 'vitest';
import { csrfTokenFor, csrfTokenMatches, isSameOriginRequest } from '@/lib/csrf';
import { generateSecret } from '@/lib/tokens';

describe('csrfTokenFor', () => {
  it('同じセッションからは同じ値、別のセッションからは別の値を導く', () => {
    // 同じセッショントークンなら何度計算しても同じ (インスタンスを増やしても再起動しても同じ)
    const session = generateSecret('user');
    expect(csrfTokenFor(session)).toBe(csrfTokenFor(session));
    // 別のセッションなら別の値 (他人のフォームの値を使い回せない)
    expect(csrfTokenFor(session)).not.toBe(csrfTokenFor(generateSecret('user')));
  });

  it('セッショントークンそのものを漏らさない URL 安全な文字列を返す', () => {
    // 1 つ導く
    const session = generateSecret('user');
    const token = csrfTokenFor(session);
    // base64url は英数字と - _ だけ (HTML にそのまま置ける)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // HMAC-SHA256 は 32 バイト = base64url で 43 文字
    expect(token).toHaveLength(43);
    // **セッショントークンが混ざっていない** (HMAC は一方向なので復元もできない)
    expect(token).not.toContain(session);
  });
});

describe('csrfTokenMatches', () => {
  it('そのセッションから導いた値なら通す', () => {
    // 画面が埋める値をそのまま送る
    const session = generateSecret('user');
    expect(csrfTokenMatches(session, csrfTokenFor(session))).toBe(true);
  });

  it('別のセッションから導いた値は拒否する', () => {
    // 他のログインで得た値を使い回せない
    const session = generateSecret('user');
    expect(csrfTokenMatches(session, csrfTokenFor(generateSecret('user')))).toBe(false);
  });

  it('セッショントークンそのものを送っても通らない', () => {
    // hidden 項目に入るのは導出した値で、セッショントークンではない
    const session = generateSecret('user');
    expect(csrfTokenMatches(session, session)).toBe(false);
  });

  it('セッションが無ければ拒否する', () => {
    // **これが要点** — 弾かないと「鍵が空の HMAC」という誰でも計算できる値が正解になり、
    // 未ログインの相手が自分で作った値で検証を通れる。
    // 守っているのは `if (!sessionToken) return false;` の 1 行で、外すとこのテストが落ちる (実測)
    expect(csrfTokenMatches(undefined, csrfTokenFor('x'))).toBe(false);
    expect(csrfTokenMatches('', csrfTokenFor(''))).toBe(false);
  });

  it('フォームが空なら拒否する', () => {
    // 空の hidden 項目は導出した値と一致しない
    expect(csrfTokenMatches(generateSecret('user'), '')).toBe(false);
  });

  it('フォームの値が文字列でなければ拒否する', () => {
    // FormData は File も返しうるので、文字列以外は拒否する
    const session = generateSecret('user');
    expect(csrfTokenMatches(session, null)).toBe(false);
    expect(csrfTokenMatches(session, undefined)).toBe(false);
    expect(csrfTokenMatches(session, 42)).toBe(false);
    expect(csrfTokenMatches(session, new Blob(['x']))).toBe(false);
  });
});

describe('isSameOriginRequest', () => {
  it('Origin のホストが Host と一致すれば通す', () => {
    // ポートまで含めて一致している
    expect(isSameOriginRequest('https://ops.example.com', 'ops.example.com')).toBe(true);
    expect(isSameOriginRequest('http://localhost:3000', 'localhost:3000')).toBe(true);
  });

  it('別ホスト・別ポートからの要求は拒否する', () => {
    // ホストが違う (典型的な CSRF)
    expect(isSameOriginRequest('https://evil.example.com', 'ops.example.com')).toBe(false);
    // ポートが違う (同じ host とは見なさない)
    expect(isSameOriginRequest('http://localhost:3001', 'localhost:3000')).toBe(false);
    // 部分一致でごまかせない
    expect(isSameOriginRequest('https://ops.example.com.evil.test', 'ops.example.com')).toBe(false);
  });

  it('Origin が無い要求は拒否する (fail-closed)', () => {
    // ヘッダを落とせる相手に検査を無効化されないよう、無いときは通さない
    expect(isSameOriginRequest(undefined, 'ops.example.com')).toBe(false);
    expect(isSameOriginRequest('', 'ops.example.com')).toBe(false);
    // Host が無いときも判定できないので拒否する
    expect(isSameOriginRequest('https://ops.example.com', undefined)).toBe(false);
  });

  it('解析できない Origin は拒否する', () => {
    // URL として読めない値 (null オリジンの文字列表現もここに落ちる)
    expect(isSameOriginRequest('null', 'ops.example.com')).toBe(false);
    expect(isSameOriginRequest('ops.example.com', 'ops.example.com')).toBe(false);
  });
});
