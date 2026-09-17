// エージェント API: 登録・取得・更新・削除・停止・復帰、入力検証、本文の防御、テナント境界、ページネーション
import { beforeEach, describe, expect, it } from 'vitest';
import { GET as listAgents, POST as createAgent } from '@/app/api/v1/agents/route';
import {
  DELETE as deleteAgent,
  GET as getAgent,
  PATCH as updateAgent,
} from '@/app/api/v1/agents/[agentId]/route';
import { POST as resumeAgent } from '@/app/api/v1/agents/[agentId]/resume/route';
import { POST as stopAgent } from '@/app/api/v1/agents/[agentId]/stop/route';
import { AgentStatus, Provider } from '@/domain/types';
import { JSON_BODY_MAX_BYTES } from '@/lib/constants';
import { call, setupSeed, type Seed } from './helpers';

// seed (各テストで作り直す)
let seed: Seed;
beforeEach(() => {
  seed = setupSeed();
});

// 有効な登録本文
const VALID = { name: '要約ボット', provider: Provider.anthropic, model: 'claude-sonnet-4-6' };

describe('POST /agents', () => {
  it('operator は登録でき、状態は active・予算は null から始まる', async () => {
    // 登録
    const result = await call(createAgent, { token: seed.a.tokens.operator, body: VALID });
    expect(result.status).toBe(201);
    const body = result.json as { tenantId: string; status: string; budgetMicroUsd: null };
    expect(body.tenantId).toBe(seed.a.id);
    expect(body.status).toBe('active');
    expect(body.budgetMicroUsd).toBeNull();
  });

  it('同一テナント内で名前が重複すると 422 (UC-03 の例外)', async () => {
    // 既存エージェントと同じ名前
    const result = await call(createAgent, {
      token: seed.a.tokens.operator,
      body: { ...VALID, name: seed.a.agent.name },
    });
    expect(result.status).toBe(422);
    expect((result.json as { issues: { path: string }[] }).issues[0].path).toBe('name');
  });

  it('予算は文字列の整数で受け、BigInt を JSON の文字列で返す', async () => {
    // 19 桁の上限値ちょうど
    const result = await call(createAgent, {
      token: seed.a.tokens.operator,
      body: { ...VALID, budgetMicroUsd: '9223372036854775807' },
    });
    expect(result.status).toBe(201);
    expect((result.json as { budgetMicroUsd: string }).budgetMicroUsd).toBe('9223372036854775807');
  });

  it('予算が BIGINT の範囲を超える・負数・小数・数値型なら 422', async () => {
    // 範囲超え / 負数 / 小数 / 数値型
    for (const budgetMicroUsd of ['9223372036854775808', '-1', '1.5', 100]) {
      const result = await call(createAgent, {
        token: seed.a.tokens.operator,
        body: { ...VALID, budgetMicroUsd },
      });
      expect(result.status, String(budgetMicroUsd)).toBe(422);
    }
  });

  it('未知のプロバイダ・空の名前は 422', async () => {
    // 未知のプロバイダ
    expect(
      (
        await call(createAgent, {
          token: seed.a.tokens.operator,
          body: { ...VALID, provider: 'x' },
        })
      ).status,
    ).toBe(422);
    // 空の名前
    expect(
      (await call(createAgent, { token: seed.a.tokens.operator, body: { ...VALID, name: '' } }))
        .status,
    ).toBe(422);
  });
});

describe('リクエスト本文の防御', () => {
  it('Content-Type が application/json でなければ 415', async () => {
    // text/plain で送る
    const result = await call(createAgent, {
      token: seed.a.tokens.operator,
      method: 'POST',
      rawBody: JSON.stringify(VALID),
      headers: { 'content-type': 'text/plain' },
    });
    expect(result.status).toBe(415);
  });

  it('JSON として壊れていれば 400', async () => {
    // 閉じ括弧が無い
    const result = await call(createAgent, {
      token: seed.a.tokens.operator,
      method: 'POST',
      rawBody: '{"name": ',
      headers: { 'content-type': 'application/json' },
    });
    expect(result.status).toBe(400);
  });

  it('本文が上限を超えれば 413', async () => {
    // 上限 + 1 バイトの本文 (説明文に詰める)
    const padding = 'a'.repeat(JSON_BODY_MAX_BYTES);
    const result = await call(createAgent, {
      token: seed.a.tokens.operator,
      body: { ...VALID, description: padding },
    });
    expect(result.status).toBe(413);
  });

  it('認証より先に本文は読まない (無認証の巨大本文も 401)', async () => {
    // トークン無しで巨大本文
    const result = await call(createAgent, {
      body: { ...VALID, description: 'a'.repeat(JSON_BODY_MAX_BYTES) },
    });
    expect(result.status).toBe(401);
  });
});

describe('GET /agents と /agents/{agentId}', () => {
  it('一覧は自テナントだけを返し、status で絞れる', async () => {
    // 停止したエージェントを 1 件足す
    await call(stopAgent, {
      token: seed.a.tokens.admin,
      method: 'POST',
      params: { agentId: seed.a.agent.id },
    });
    await call(createAgent, { token: seed.a.tokens.operator, body: VALID });
    // 全件
    const all = await call(listAgents, { token: seed.a.tokens.viewer });
    const items = (all.json as { items: { tenantId: string }[] }).items;
    expect(items).toHaveLength(2);
    expect(items.every((a) => a.tenantId === seed.a.id)).toBe(true);
    // stopped だけ
    const stopped = await call(listAgents, {
      token: seed.a.tokens.viewer,
      query: 'status=stopped',
    });
    expect((stopped.json as { items: { id: string }[] }).items.map((a) => a.id)).toEqual([
      seed.a.agent.id,
    ]);
    // 未知の状態は 422
    expect(
      (await call(listAgents, { token: seed.a.tokens.viewer, query: 'status=x' })).status,
    ).toBe(422);
  });

  it('カーソルでページ送りでき、存在しないカーソルは空ページ', async () => {
    // 合計 3 件にする
    await call(createAgent, { token: seed.a.tokens.operator, body: { ...VALID, name: 'b' } });
    await call(createAgent, { token: seed.a.tokens.operator, body: { ...VALID, name: 'c' } });
    // 2 件ずつ
    const page1 = (await call(listAgents, { token: seed.a.tokens.viewer, query: 'limit=2' }))
      .json as { items: { id: string }[]; nextCursor?: string };
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBe(page1.items[1].id);
    const page2 = (
      await call(listAgents, {
        token: seed.a.tokens.viewer,
        query: `limit=2&cursor=${page1.nextCursor}`,
      })
    ).json as { items: { id: string }[]; nextCursor?: string };
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeUndefined();
    // 3 ページ分の id に重複が無いこと
    const ids = [...page1.items, ...page2.items].map((a) => a.id);
    expect(new Set(ids).size).toBe(3);
    // 存在しないカーソル
    const none = (await call(listAgents, { token: seed.a.tokens.viewer, query: 'cursor=nope' }))
      .json as { items: unknown[] };
    expect(none.items).toHaveLength(0);
  });

  it('他テナントのエージェントは取得・更新・削除・停止・復帰のすべてで 404', async () => {
    // テナント B のエージェントをテナント A の admin が触る
    const params = { agentId: seed.b.agent.id };
    const token = seed.a.tokens.admin;
    expect((await call(getAgent, { token, params })).status).toBe(404);
    expect(
      (await call(updateAgent, { token, method: 'PATCH', params, body: { name: 'x' } })).status,
    ).toBe(404);
    expect((await call(deleteAgent, { token, method: 'DELETE', params })).status).toBe(404);
    expect((await call(stopAgent, { token, method: 'POST', params })).status).toBe(404);
    expect((await call(resumeAgent, { token, method: 'POST', params })).status).toBe(404);
    // テナント B 側は何も変わっていない
    expect(seed.store.agents.get(seed.b.agent.id)?.status).toBe(AgentStatus.active);
  });
});

describe('PATCH /agents/{agentId}', () => {
  it('省略したプロパティは変わらず、null で未設定へ戻せる', async () => {
    // 予算と説明を付ける
    const params = { agentId: seed.a.agent.id };
    await call(updateAgent, {
      token: seed.a.tokens.operator,
      method: 'PATCH',
      params,
      body: { description: '説明', budgetMicroUsd: '1000000' },
    });
    // 名前だけ変える
    const renamed = await call(updateAgent, {
      token: seed.a.tokens.operator,
      method: 'PATCH',
      params,
      body: { name: '改名' },
    });
    const afterRename = renamed.json as {
      name: string;
      description: string;
      budgetMicroUsd: string;
    };
    expect(afterRename.name).toBe('改名');
    expect(afterRename.description).toBe('説明');
    expect(afterRename.budgetMicroUsd).toBe('1000000');
    // null で戻す
    const cleared = await call(updateAgent, {
      token: seed.a.tokens.operator,
      method: 'PATCH',
      params,
      body: { description: null, budgetMicroUsd: null },
    });
    const afterClear = cleared.json as { description: null; budgetMicroUsd: null };
    expect(afterClear.description).toBeNull();
    expect(afterClear.budgetMicroUsd).toBeNull();
  });

  it('改名先が既存の名前と重複すると 422', async () => {
    // b を作ってから既存の名前へ改名する
    const created = await call(createAgent, {
      token: seed.a.tokens.operator,
      body: { ...VALID, name: 'b' },
    });
    const result = await call(updateAgent, {
      token: seed.a.tokens.operator,
      method: 'PATCH',
      params: { agentId: (created.json as { id: string }).id },
      body: { name: seed.a.agent.name },
    });
    expect(result.status).toBe(422);
  });
});

describe('停止・復帰・削除', () => {
  it('stop で stopped、resume で active に戻る (冪等)', async () => {
    // 停止
    const params = { agentId: seed.a.agent.id };
    const stopped = await call(stopAgent, { token: seed.a.tokens.admin, method: 'POST', params });
    expect((stopped.json as { status: string }).status).toBe('stopped');
    // もう一度停止しても 200
    expect(
      (await call(stopAgent, { token: seed.a.tokens.admin, method: 'POST', params })).status,
    ).toBe(200);
    // 復帰
    const resumed = await call(resumeAgent, { token: seed.a.tokens.admin, method: 'POST', params });
    expect((resumed.json as { status: string }).status).toBe('active');
  });

  it('suspended (自動停止) からも resume で active に戻る (UC-09)', async () => {
    // ガードレールが止めた状態を作る
    seed.store.agents.get(seed.a.agent.id)!.status = AgentStatus.suspended;
    const resumed = await call(resumeAgent, {
      token: seed.a.tokens.admin,
      method: 'POST',
      params: { agentId: seed.a.agent.id },
    });
    expect((resumed.json as { status: string }).status).toBe('active');
  });

  it('履歴の無いエージェントは削除でき (204)、以後 404', async () => {
    // 削除
    const params = { agentId: seed.a.agent.id };
    expect(
      (await call(deleteAgent, { token: seed.a.tokens.admin, method: 'DELETE', params })).status,
    ).toBe(204);
    expect((await call(getAgent, { token: seed.a.tokens.admin, params })).status).toBe(404);
  });

  it('履歴を持つエージェントは削除できず 409 (stop を使う。docs/spec.md §3)', async () => {
    // 履歴があることにする
    seed.store.agentIdsWithHistory.add(seed.a.agent.id);
    const result = await call(deleteAgent, {
      token: seed.a.tokens.admin,
      method: 'DELETE',
      params: { agentId: seed.a.agent.id },
    });
    expect(result.status).toBe(409);
    // 消えていない
    expect(seed.store.agents.has(seed.a.agent.id)).toBe(true);
  });
});
