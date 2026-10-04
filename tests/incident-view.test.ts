// インシデント一覧の表示条件（Step5）の解釈の検査。
//
// **「採用しなかった指定を伝えるか」を固定するのが要点** — 黙って既定へ倒すと、
// 利用者は「すべて見た」つもりで未解決だけを読む。
import { describe, expect, it } from 'vitest';
import { IncidentStatus } from '@/domain/types';
import { UI_TEXT } from '@/lib/constants';
import {
  INCIDENT_VIEW_ALL,
  INCIDENT_VIEW_OPEN,
  resolveIncidentView,
} from '@/lib/dashboard/incident-view';

describe('インシデント一覧の表示条件', () => {
  it('指定が無ければ未解決だけを見る', () => {
    // 既定は未解決（ダッシュボードの「未解決インシデント」から飛んでくる先）
    const view = resolveIncidentView(undefined);
    expect(view.status).toBe(IncidentStatus.open);
    expect(view.showAll).toBe(false);
    // 指定していないので旗は立たない
    expect(view.ignoredInput).toBe(false);
  });

  it('空文字も指定が無いものとして扱う', () => {
    // `?status=` のような送信（空の select）でも既定へ倒すが、旗は立てない
    const view = resolveIncidentView('');
    expect(view.status).toBe(IncidentStatus.open);
    expect(view.ignoredInput).toBe(false);
  });

  it('all ならすべて見る（絞り込みを渡さない）', () => {
    // 解決済みも含めて見る
    const view = resolveIncidentView(INCIDENT_VIEW_ALL);
    expect(view.status).toBeUndefined();
    expect(view.showAll).toBe(true);
    expect(view.ignoredInput).toBe(false);
  });

  it('open の明示も受け付ける', () => {
    // 切り替えリンクが付ける値
    const view = resolveIncidentView(INCIDENT_VIEW_OPEN);
    expect(view.status).toBe(IncidentStatus.open);
    expect(view.showAll).toBe(false);
    expect(view.ignoredInput).toBe(false);
  });

  it('知らない値は既定へ倒し、採用しなかったことを旗で伝える', () => {
    // enum の値をそのまま書いた形（`resolved`）も「選べる値」ではない
    for (const raw of ['resolved', 'ALL', 'おまかせ']) {
      const view = resolveIncidentView(raw);
      // 既定（未解決だけ）へ倒れている
      expect(view.status).toBe(IncidentStatus.open);
      expect(view.showAll).toBe(false);
      // 旗が立ち、理由の文言も付く
      expect(view.ignoredInput).toBe(true);
      expect(view.ignoredReason).toBe(UI_TEXT.incidentViewIgnored);
    }
  });
});
