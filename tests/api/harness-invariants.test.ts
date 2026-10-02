// API テストの土台（`tests/api/helpers.ts`）そのものの不変条件。
//
// ここに置くのは「外れてもテストは全部緑のまま、開発機でだけ実害が出る」もの。
// 実害の例: テスト中に**本物の通知先へ POST する**（開発機のシェルに `NOTIFY_WEBHOOK_URL` と
// 署名鍵が export してあると、ガードレールの発火を伴うテストが実際に送る）。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { seedEachTest } from './helpers';

// 設定の雛形（通知の設定名の正本）
const EXAMPLE = readFileSync(join(process.cwd(), '.env.example'), 'utf8');

// 雛形に現れる通知まわりの設定名（`NOTIFY_...=` の形の行）。
// **手で並べない** — 宛先や署名鍵を 1 本足した人が土台への追記を忘れると、そのぶんだけ
// 「テストが外へ出る」経路が開く（しかもテストは全部緑のまま）
function notifyEnvNames(): string[] {
  // 行頭が NOTIFY_ で始まる設定名を拾う
  return [...EXAMPLE.matchAll(/^(NOTIFY_[A-Z0-9_]*)=/gm)].map((matched) => matched[1]);
}

describe('API テストの土台', () => {
  // 土台を各テストの前に用意する（これ自体が検査対象）
  seedEachTest();

  it('通知の設定をすべて空にして、テストから外へ出さない', () => {
    // 雛形から導いた設定名
    const names = notifyEnvNames();
    // 1 件も読めなければ走査が壊れている（fail-closed。「対象ゼロ＝緑」にしない）
    expect(names.length, '.env.example から通知の設定名を 1 件も読めない').toBeGreaterThan(0);
    for (const name of names) {
      // 空文字であること（未設定でも「宛先なし」だが、開発機の値が残っていると送ってしまう）
      expect(process.env[name], `${name} が空でない (テストが本物の宛先へ POST しうる)`).toBe('');
    }
  });
});
