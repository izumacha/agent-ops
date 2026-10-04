// ダッシュボードの書き込み操作を守る CSRF 対策 (Step5 / ADR-0011) の検査。
// 「通してはいけない組み合わせ」を 1 つずつ固定する。
import { describe, expect, it } from 'vitest';
import { createCsrfToken, csrfTokenMatches, isSameOriginRequest } from '@/lib/csrf';

describe('createCsrfToken', () => {
  it('毎回違う値を作る', () => {
    // 2 回作って一致しないことを見る (固定値を返す実装を落とす)
    expect(createCsrfToken()).not.toBe(createCsrfToken());
  });

  it('推測できない長さの URL 安全な文字列を作る', () => {
    // 1 つ作る
    const token = createCsrfToken();
    // base64url は英数字と - _ だけ (Cookie と HTML にそのまま置ける)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 バイトを base64url にすると 43 文字。短くする変異を落とすため下限を置く
    expect(token.length).toBeGreaterThanOrEqual(43);
  });
});

describe('csrfTokenMatches', () => {
  it('Cookie とフォームの値が一致すれば通す', () => {
    // 同じ値なら一致
    const token = createCsrfToken();
    expect(csrfTokenMatches(token, token)).toBe(true);
  });

  it('値が違えば拒否する', () => {
    // 別々に作った 2 つは一致しない
    expect(csrfTokenMatches(createCsrfToken(), createCsrfToken())).toBe(false);
  });

  it('Cookie が無ければ拒否する', () => {
    // Cookie 側が undefined / 空のときは、フォームに何が入っていても拒否する
    expect(csrfTokenMatches(undefined, createCsrfToken())).toBe(false);
    expect(csrfTokenMatches('', createCsrfToken())).toBe(false);
  });

  it('空どうしを一致と判定しない', () => {
    // **これが要点** — 定数時間比較は両辺をハッシュするので「空 vs 空」は一致してしまう。
    // Cookie を持たない相手が空の hidden 項目を送るだけで通る、という抜け道を塞ぐ。
    // 守っているのは `if (!cookieToken) return false;` の 1 行で、外すとこのテストが落ちる (実測)
    expect(csrfTokenMatches('', '')).toBe(false);
  });

  it('Cookie があってもフォームが空なら拒否する', () => {
    // 空の hidden 項目はハッシュが一致しないので通らない
    expect(csrfTokenMatches(createCsrfToken(), '')).toBe(false);
  });

  it('フォームの値が文字列でなければ拒否する', () => {
    // FormData は File も返しうるので、文字列以外は拒否する
    const token = createCsrfToken();
    expect(csrfTokenMatches(token, null)).toBe(false);
    expect(csrfTokenMatches(token, undefined)).toBe(false);
    expect(csrfTokenMatches(token, 42)).toBe(false);
    expect(csrfTokenMatches(token, new Blob(['x']))).toBe(false);
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
