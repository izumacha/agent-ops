// 人が指定できるエージェントの状態（Step5）の読み替えの検査。
//
// **画面から送られる値を表と突き合わせる**ところが要点 — フォームの値は書き換えられるので、
// 「`suspended` を指定する」形をここで落とさないと、人が手で自動停止の状態を作れてしまう
// （そうなると「誰かが手で止めた」記録と自動停止の記録が区別できなくなる）。
import { describe, expect, it } from 'vitest';
import {
  AGENT_STATUS_AUDIT_ACTION,
  AGENT_STATUS_BY_INTENT,
  AgentStatusIntent,
  settableStatusForIntent,
} from '@/domain/agent-status';
import { AuditAction } from '@/domain/audit/action';
import { AgentStatus } from '@/domain/types';

describe('settableStatusForIntent', () => {
  it('stop は停止、resume は稼働中へ読み替える', () => {
    // 表のとおりに読み替わる
    expect(settableStatusForIntent(AgentStatusIntent.stop)).toBe(AgentStatus.stopped);
    expect(settableStatusForIntent(AgentStatusIntent.resume)).toBe(AgentStatus.active);
  });

  it('知らない値は null（fail-closed）', () => {
    // 状態の綴りを直接送る形・空・別の語はすべて読み替えない
    for (const raw of [AgentStatus.suspended, AgentStatus.active, '', 'STOP', 'おまかせ']) {
      expect(settableStatusForIntent(raw), `${raw} が通ってしまう`).toBeNull();
    }
  });

  it('文字列でない値も null（FormData は File も返す）', () => {
    // 型で弾く（undefined / null / オブジェクト）
    for (const raw of [undefined, null, 42, {}, new Blob([])]) {
      expect(settableStatusForIntent(raw)).toBeNull();
    }
  });

  it('Object.prototype 由来の名前も null（素の添字だと値が返る）', () => {
    // `constructor` / `toString` / `__proto__` は表の自身のキーではない
    for (const raw of ['constructor', 'toString', '__proto__', 'valueOf']) {
      expect(settableStatusForIntent(raw), `${raw} が通ってしまう`).toBeNull();
    }
  });

  it('意図の表と監査ログの表は同じ状態を覆っている', () => {
    // **片方だけに状態が増える形を落とす** — 意図を足して監査ログの操作名を書き忘れると、
    // その操作だけ記録が別の名前になる（あるいは undefined で書かれる）
    const fromIntents = new Set(Object.values(AGENT_STATUS_BY_INTENT));
    const audited = new Set(Object.keys(AGENT_STATUS_AUDIT_ACTION));
    // 意図から出てくる状態がすべて監査ログの表にあること
    for (const status of fromIntents) expect(audited.has(status)).toBe(true);
    // 逆も見る（記録だけ用意されていて画面から到達できない状態を残さない）
    expect(fromIntents.size).toBe(audited.size);
    // 操作名そのものも固定する（API 経路と同じ名前を使う）
    expect(AGENT_STATUS_AUDIT_ACTION[AgentStatus.stopped]).toBe(AuditAction.agent_stopped);
    expect(AGENT_STATUS_AUDIT_ACTION[AgentStatus.active]).toBe(AuditAction.agent_resumed);
  });
});
