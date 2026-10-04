// 稼働率の計算 (ダッシュボード Step5) の検査。境界 — とくに「測れない」を 0% と読まないこと — を固定する。
import { describe, expect, it } from 'vitest';
import { USAGE_ERROR_STATUS_FLOOR } from '@/domain/guardrail/rule';
import { UPTIME_ERROR_STATUS_FLOOR, uptimeRate } from '@/domain/uptime';

describe('uptimeRate', () => {
  it('成功だけの期間は 1 (100%) を返す', () => {
    // 10 件すべて成功
    expect(uptimeRate(10, 0)).toBe(1);
  });

  it('全件失敗した期間は 0 を返す', () => {
    // 分母と分子が同じ = 成功 0 件
    expect(uptimeRate(4, 4)).toBe(0);
  });

  it('割合をそのまま返し、丸めない', () => {
    // 3 件中 1 件失敗 = 2/3。表示の桁は画面側が決めるので、ここでは丸めない
    expect(uptimeRate(3, 1)).toBe(2 / 3);
  });

  it('呼び出しが 0 件の期間は null (0% と読まない)', () => {
    // **これが要点** — まだ 1 度も呼ばれていないエージェントを「稼働率 0%」と表示すると、
    // 運用者は障害が起きていると読む。Step4 の「測れていないものは発火させない」と同じ流儀
    expect(uptimeRate(0, 0)).toBeNull();
  });

  it('対が壊れている組み合わせは null に倒す (嘘の百分率を出さない)', () => {
    // 分子が分母を超える / 負の値 / 分母が負 — いずれもデータが壊れている状態
    expect(uptimeRate(2, 3)).toBeNull();
    expect(uptimeRate(5, -1)).toBeNull();
    expect(uptimeRate(-1, 0)).toBeNull();
  });

  it('整数でない・有限でない値は null に倒す', () => {
    // 小数・NaN・無限は件数として成立しない
    expect(uptimeRate(1.5, 0)).toBeNull();
    expect(uptimeRate(10, 0.5)).toBeNull();
    expect(uptimeRate(Number.NaN, 0)).toBeNull();
    expect(uptimeRate(Number.POSITIVE_INFINITY, 0)).toBeNull();
  });
});

describe('失敗とみなす下限', () => {
  it('ガードレールのエラー率と同じ値を使う', () => {
    // **数え方を 2 つ持たない** — 画面の稼働率と自動停止のエラー率が別の下限で数えていると、
    // 「稼働率は 100% なのにエラー率で停止した」という説明できない状態が起きる
    expect(UPTIME_ERROR_STATUS_FLOOR).toBe(USAGE_ERROR_STATUS_FLOOR);
  });
});
