// API キー API: 発行 (平文は 1 度だけ)・一覧・失効・エージェント紐づけ・テナント境界
import { describe, expect, it } from 'vitest';
import { GET as listKeys, POST as createKey } from '@/app/api/v1/api-keys/route';
import { DELETE as revokeKey } from '@/app/api/v1/api-keys/[apiKeyId]/route';
import { DELETE as deleteAgent } from '@/app/api/v1/agents/[agentId]/route';
import { API_KEY_PREFIX, hashSecret } from '@/lib/tokens';
import { call, seedEachTest } from './helpers';

// seed (各テストで作り直し、後始末も helpers が行う)
const seed = seedEachTest();

describe('POST /api-keys', () => {
  it('operator は発行でき、平文は応答にだけ載り DB にはハッシュだけ残る (UC-04)', async () => {
    // 発行
    const result = await call(createKey, {
      token: seed.a.tokens.operator,
      body: { name: 'CI 用' },
    });
    expect(result.status).toBe(201);
    const body = result.json as { id: string; secret: string; prefix: string; agentId: null };
    expect(body.secret.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(body.secret.startsWith(body.prefix)).toBe(true);
    expect(body.agentId).toBeNull();
    // DB にはハッシュだけ
    const row = seed.store.apiKeys.get(body.id)!;
    expect(row.keyHash).toBe(hashSecret(body.secret));
    expect(JSON.stringify([...seed.store.apiKeys.values()])).not.toContain(body.secret);
    // 一覧にも平文は無い
    const list = await call(listKeys, { token: seed.a.tokens.viewer });
    expect(JSON.stringify(list.json)).not.toContain(body.secret);
    expect(JSON.stringify(list.json)).not.toContain('keyHash');
  });

  it('自テナントのエージェントに紐づけて発行できる', async () => {
    // 既存エージェントを指定する
    const result = await call(createKey, {
      token: seed.a.tokens.operator,
      body: { name: '専用', agentId: seed.a.agent.id },
    });
    expect(result.status).toBe(201);
    expect((result.json as { agentId: string }).agentId).toBe(seed.a.agent.id);
  });

  it('他テナントのエージェント・存在しないエージェントは 422 (issues.path = agentId)', async () => {
    // テナント B のエージェント / 存在しない id
    for (const agentId of [seed.b.agent.id, 'nope']) {
      const result = await call(createKey, {
        token: seed.a.tokens.operator,
        body: { name: 'x', agentId },
      });
      expect(result.status, agentId).toBe(422);
      expect((result.json as { issues: { path: string }[] }).issues[0].path).toBe('agentId');
    }
  });

  it('エージェントを削除すると専用キーも一緒に消える (Cascade。docs/spec.md §3)', async () => {
    // 専用キーを発行してからエージェントを削除する
    const key = (
      await call(createKey, {
        token: seed.a.tokens.operator,
        body: { name: '専用', agentId: seed.a.agent.id },
      })
    ).json as { id: string };
    await call(deleteAgent, {
      token: seed.a.tokens.admin,
      method: 'DELETE',
      params: { agentId: seed.a.agent.id },
    });
    // キーは消えている
    expect(seed.store.apiKeys.has(key.id)).toBe(false);
  });
});

describe('DELETE /api-keys/{apiKeyId}', () => {
  it('admin は失効でき、一覧に revokedAt が付く (冪等)', async () => {
    // 発行
    const key = (await call(createKey, { token: seed.a.tokens.operator, body: { name: 'x' } }))
      .json as { id: string };
    // 失効
    const params = { apiKeyId: key.id };
    expect(
      (await call(revokeKey, { token: seed.a.tokens.admin, method: 'DELETE', params })).status,
    ).toBe(204);
    // 一覧で revokedAt が非 null
    const list = await call(listKeys, { token: seed.a.tokens.viewer });
    const item = (list.json as { items: { id: string; revokedAt: string | null }[] }).items.find(
      (k) => k.id === key.id,
    );
    expect(item?.revokedAt).not.toBeNull();
    // 2 回目も 204 で日時は変わらない
    const before = seed.store.apiKeys.get(key.id)!.revokedAt;
    expect(
      (await call(revokeKey, { token: seed.a.tokens.admin, method: 'DELETE', params })).status,
    ).toBe(204);
    expect(seed.store.apiKeys.get(key.id)!.revokedAt).toBe(before);
  });

  it('他テナントのキーは 404、operator は 403 (stop 権限)', async () => {
    // テナント B で発行したキー
    const key = (await call(createKey, { token: seed.b.tokens.operator, body: { name: 'x' } }))
      .json as { id: string };
    const params = { apiKeyId: key.id };
    // テナント A の admin からは見えない
    expect(
      (await call(revokeKey, { token: seed.a.tokens.admin, method: 'DELETE', params })).status,
    ).toBe(404);
    // テナント B の operator には stop 権限が無い
    expect(
      (await call(revokeKey, { token: seed.b.tokens.operator, method: 'DELETE', params })).status,
    ).toBe(403);
  });
});
