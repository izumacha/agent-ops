// API テストの土台（`tests/api/helpers.ts`）のうち、**順序**だけが効いている不変条件。
//
// 土台はレート制限の上限の設定（`PROXY_RATE_LIMIT_PER_MINUTE`）を空にし、共有の制限器を
// 作り直す。**作り直しが「空にする」より前だと、上限を開発機・CI の環境変数から読む** —
// 実測で `PROXY_RATE_LIMIT_PER_MINUTE=1` を設定した環境では中継・評価・E2E の 6 件が
// 429 で落ちた。一方 `tests/api/harness-invariants.test.ts` の見張りは**テスト本体の中で
// 空であること**しか見ないので、制限器が既に古い値で作られていても緑のまま通る。
//
// そこでこのファイルは**制限器が作られる前に**環境変数へ小さい上限を入れ、
// レート制限が掛かるルートを 2 回呼んでどちらも 429 にならないことを見る。
// ファイル単位で worker が分かれる（`isolate: true`）ので、この代入は他のファイルへ漏れない。
import { describe, expect, it } from 'vitest';
import { PROXY_RATE_LIMIT_ENV } from '@/lib/constants';

// **import の直後・`seedEachTest()` の beforeEach より前に設定する**（順序がこの検査の主題）。
// 1 にすると「1 分あたり 1 回」なので、順序が逆なら 2 回目の呼び出しが必ず 429 になる
process.env[PROXY_RATE_LIMIT_ENV] = '1';

// 土台とルートはこの後に読む（土台の import が副作用を持たないことにも依存しない）
const { POST: runGuardrails } = await import('@/app/api/v1/guardrails/run/route');
const { call, seedEachTest } = await import('./helpers');

describe('API テストの土台: レート制限の上限を空にする順序', () => {
  // 土台を各テストの前に用意する（これ自体が検査対象）
  const seed = seedEachTest();

  it('実行環境に小さい上限が設定されていても 2 回続けて通る', async () => {
    // 1 回目（ルールが無いので上流も DB の集計もほぼ動かない）
    const first = await call(runGuardrails, {
      token: seed.a.tokens.admin,
      body: { agentId: seed.a.agent.id },
    });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    // **2 回目が要点** — 制限器が環境変数の 1 を読んでいれば、ここで 429 になる
    const second = await call(runGuardrails, {
      token: seed.a.tokens.admin,
      body: { agentId: seed.a.agent.id },
    });
    expect(second.status, `2 回目が ${second.status}（土台が上限を環境から読んでいる）`).toBe(200);
  });
});
