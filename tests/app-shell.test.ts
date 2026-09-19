// 画面の骨組み (src/app) のうち、壊れても API テストからは一切見えない性質を固定する。
// 実測では `lang="ja"` を `"en"` に変えても lint・typecheck・全テストが緑のままだった
// (src/app 配下を読むテストが 1 本も無かったため)。
// 判定は JSX を描画せず、要素の props を見るだけにする (DOM 環境を持ち込まない)
import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import RootLayout, { metadata } from '@/app/layout';
import { APP_NAME } from '@/lib/constants';

describe('ルートレイアウト', () => {
  it('文書の言語は日本語 (§7 a11y: lang は実際の UI 言語に一致させる)', () => {
    // レイアウトを関数として呼び、返る要素を見る
    const element = RootLayout({ children: null }) as ReactElement<{ lang?: string }>;
    // ルート要素は html
    expect(element.type).toBe('html');
    // UI 文言は日本語なので lang="ja" (発音・言語処理が支援技術の挙動を左右する)
    expect(element.props.lang).toBe('ja');
  });

  it('タブ名はアプリ名の一元管理から引く (文言を直書きしない §6)', () => {
    // metadata.title が定数と一致すること
    expect(metadata.title).toBe(APP_NAME);
  });
});
