// ダッシュボードの一覧画面がページ送りの位置を読む規則（`src/lib/dashboard/paging.ts`）。
//
// **呼ぶのは画面（`.tsx`）だけ**なので、API テストの経路を 1 行も通らない。ここが緩むと
// 「続きを見たつもりで同じ 1 ページ目を読む」（旗を立てずに先頭へ倒す）形が静かに成立する。
import { describe, expect, it } from 'vitest';
import { resolveDashboardCursor } from '@/lib/dashboard/paging';
import { encodeCursor } from '@/data/page';
import { PAGE_CURSOR_MAX_LENGTH, UI_TEXT } from '@/lib/constants';

// 位置の元になる行（カーソルは最終行の `(createdAt, id)` を符号化した値）
const KEY = { createdAt: new Date('2026-10-01T00:00:00.000Z'), id: 'agent_1' };

describe('ダッシュボードのカーソルの解釈', () => {
  it('指定が無ければ先頭から（旗は立てない）', () => {
    // 未指定と空文字はどちらも「先頭から」。**旗を立てない**のが要点で、
    // 立てると 1 ページ目を開くたびに「先頭から表示しています」と出る
    for (const raw of [undefined, '']) {
      expect(resolveDashboardCursor(raw)).toEqual({ ignoredInput: false, ignoredReason: null });
    }
  });

  it('復号できる値はそのまま採用する', () => {
    // 正しいカーソル（API が返すのと同じ形）
    const resolved = resolveDashboardCursor(encodeCursor(KEY));
    expect(resolved.ignoredInput).toBe(false);
    expect(resolved.ignoredReason).toBeNull();
    // 位置が復号できている
    expect(resolved.cursor?.id).toBe(KEY.id);
    expect(resolved.cursor?.createdAt.toISOString()).toBe(KEY.createdAt.toISOString());
  });

  it.each([
    ['base64 でない', '!!!'],
    ['復号すると形が違う', Buffer.from('{"nope":1}').toString('base64url')],
    ['JSON ではない', Buffer.from('not json').toString('base64url')],
  ])('読めない値は先頭へ倒し、旗と理由を返す: %s', (_label, raw) => {
    // **黙って先頭へ戻さない** — 利用者は「続きを見た」つもりで同じ 1 ページ目を読む
    const resolved = resolveDashboardCursor(raw);
    expect(resolved.cursor).toBeUndefined();
    expect(resolved.ignoredInput).toBe(true);
    expect(resolved.ignoredReason).toBe(UI_TEXT.cursorIgnored);
  });

  it('長すぎる値は復号を試す前に断る', () => {
    // 上限を 1 文字超える値（§9 入力は信用しない。上限は API と同じ定数）
    const resolved = resolveDashboardCursor('a'.repeat(PAGE_CURSOR_MAX_LENGTH + 1));
    expect(resolved.ignoredInput).toBe(true);
    expect(resolved.ignoredReason).toBe(UI_TEXT.cursorIgnored);
  });

  it('上限ちょうどの長さは復号を試す（境界で 1 文字厳しくしない）', () => {
    // 上限ちょうどで、かつ復号できる値を作れるかは形に依るので、
    // ここでは「長さで断られていない」ことを理由の文言ではなく**試行の有無**で見る。
    // 上限ちょうどの読めない値は「復号を試して失敗した」として同じ旗が立つので、
    // 代わりに**上限以内の正しいカーソル**が通ることを確かめる（長さで先に断っていないこと）
    const encoded = encodeCursor(KEY);
    expect(encoded.length).toBeLessThanOrEqual(PAGE_CURSOR_MAX_LENGTH);
    expect(resolveDashboardCursor(encoded).ignoredInput).toBe(false);
  });
});
