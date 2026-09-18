// ユーザー API: 招待・役割変更・無効化・ログイントークン (admin ロール限定) とテナント境界
import { describe, expect, it } from 'vitest';
import { getRepos } from '@/data';
import { GET as getMe } from '@/app/api/v1/me/route';
import { GET as listUsers, POST as createUser } from '@/app/api/v1/users/route';
import { DELETE as disableUser } from '@/app/api/v1/users/[userId]/route';
import { PUT as updateRole } from '@/app/api/v1/users/[userId]/role/route';
import { GET as listTokens, POST as createToken } from '@/app/api/v1/users/[userId]/tokens/route';
import { DELETE as revokeToken } from '@/app/api/v1/users/[userId]/tokens/[tokenId]/route';
import { Role } from '@/domain/types';
import { API_MESSAGES } from '@/lib/constants';
import { USER_TOKEN_PREFIX } from '@/lib/tokens';
import { call, seedEachTest } from './helpers';

// seed (各テストで作り直し、後始末も helpers が行う)
const seed = seedEachTest();

describe('GET /users', () => {
  it('自テナントのユーザーだけを返す (他テナントは混ざらない)', async () => {
    // viewer で一覧する
    const result = await call(listUsers, { token: seed.a.tokens.viewer });
    expect(result.status).toBe(200);
    // 全員テナント A
    const items = (result.json as { items: { tenantId: string }[] }).items;
    expect(items).toHaveLength(3);
    expect(items.every((u) => u.tenantId === seed.a.id)).toBe(true);
  });
});

describe('POST /users', () => {
  it('admin は招待でき、既定で無効化されていない', async () => {
    // 招待
    const result = await call(createUser, {
      token: seed.a.tokens.admin,
      body: { email: 'new@example.com', name: '新人', role: Role.operator },
    });
    expect(result.status).toBe(201);
    const body = result.json as { tenantId: string; role: string; disabledAt: null };
    expect(body.tenantId).toBe(seed.a.id);
    expect(body.role).toBe('operator');
    expect(body.disabledAt).toBeNull();
  });

  it('同一テナント内でメールが重複すると 422 (issues.path = email)', async () => {
    // 既存の viewer と同じメール
    const result = await call(createUser, {
      token: seed.a.tokens.admin,
      body: { email: seed.a.users.viewer.email, name: 'x', role: Role.viewer },
    });
    expect(result.status).toBe(422);
    expect((result.json as { issues: { path: string }[] }).issues[0].path).toBe('email');
  });

  it('メールは前後の空白を除いて小文字に正規化され、大文字小文字違いの重複も 422', async () => {
    // 前後の空白と大文字混じりで招待する (CLI の --email と同じ規則で受ける)
    const created = await call(createUser, {
      token: seed.a.tokens.admin,
      body: { email: ' Alice@Example.com ', name: 'Alice', role: Role.viewer },
    });
    expect(created.status).toBe(201);
    expect((created.json as { email: string }).email).toBe('alice@example.com');
    // 小文字で同じ受信箱を招待すると重複
    const dup = await call(createUser, {
      token: seed.a.tokens.admin,
      body: { email: 'alice@example.com', name: 'Alice 2', role: Role.viewer },
    });
    expect(dup.status).toBe(422);
  });

  it('別テナントなら同じメールでも招待できる (一意性はテナント内)', async () => {
    // テナント B の admin がテナント A と同じメールを招待する
    const result = await call(createUser, {
      token: seed.b.tokens.admin,
      body: { email: seed.a.users.viewer.email, name: 'x', role: Role.viewer },
    });
    expect(result.status).toBe(201);
  });

  it('未知の役割は 422', async () => {
    // root という役割は無い
    const result = await call(createUser, {
      token: seed.a.tokens.admin,
      body: { email: 'r@example.com', name: 'r', role: 'root' },
    });
    expect(result.status).toBe(422);
  });
});

describe('PUT /users/{userId}/role', () => {
  it('admin は役割を変えられる', async () => {
    // viewer → operator
    const result = await call(updateRole, {
      token: seed.a.tokens.admin,
      method: 'PUT',
      params: { userId: seed.a.users.viewer.id },
      body: { role: Role.operator },
    });
    expect(result.status).toBe(200);
    expect((result.json as { role: string }).role).toBe('operator');
    // 変更後は execute 系の権限で振る舞う (トークンはそのまま有効)
    const me = await call(getMe, { token: seed.a.tokens.viewer });
    expect((me.json as { user: { role: string } }).user.role).toBe('operator');
  });

  it('最後の有効な admin を降格すると 409', async () => {
    // テナント A の admin は 1 人
    const result = await call(updateRole, {
      token: seed.a.tokens.admin,
      method: 'PUT',
      params: { userId: seed.a.users.admin.id },
      body: { role: Role.viewer },
    });
    expect(result.status).toBe(409);
  });

  it('admin が 2 人いれば片方を降格できる', async () => {
    // operator を admin に昇格させてから、元の admin を降格する
    await call(updateRole, {
      token: seed.a.tokens.admin,
      method: 'PUT',
      params: { userId: seed.a.users.operator.id },
      body: { role: Role.admin },
    });
    const result = await call(updateRole, {
      token: seed.a.tokens.admin,
      method: 'PUT',
      params: { userId: seed.a.users.admin.id },
      body: { role: Role.viewer },
    });
    expect(result.status).toBe(200);
  });

  it('他テナントのユーザーは 404', async () => {
    // テナント B のユーザーをテナント A の admin が変えようとする
    const result = await call(updateRole, {
      token: seed.a.tokens.admin,
      method: 'PUT',
      params: { userId: seed.b.users.viewer.id },
      body: { role: Role.admin },
    });
    expect(result.status).toBe(404);
  });
});

describe('DELETE /users/{userId} (無効化)', () => {
  it('無効化するとそのユーザーのトークンが 401 になる', async () => {
    // viewer を無効化する
    const result = await call(disableUser, {
      token: seed.a.tokens.admin,
      method: 'DELETE',
      params: { userId: seed.a.users.viewer.id },
    });
    expect(result.status).toBe(200);
    expect((result.json as { disabledAt: string | null }).disabledAt).not.toBeNull();
    // 以後は認証できない
    expect((await call(getMe, { token: seed.a.tokens.viewer })).status).toBe(401);
  });

  it('他に有効な admin が居ても自分自身は無効化できない (409。文言は selfDisable)', async () => {
    // viewer を admin に昇格させ、admin を 2 人にする
    expect(
      (
        await call(updateRole, {
          token: seed.a.tokens.admin,
          method: 'PUT',
          params: { userId: seed.a.users.viewer.id },
          body: { role: Role.admin },
        })
      ).status,
    ).toBe(200);
    // 自分自身の無効化は last_admin ではなく selfDisable で 409
    const result = await call(disableUser, {
      token: seed.a.tokens.admin,
      method: 'DELETE',
      params: { userId: seed.a.users.admin.id },
    });
    expect(result.status).toBe(409);
    expect((result.json as { message: string }).message).toBe(API_MESSAGES.selfDisable);
  });

  it('URL のユーザーと発行先が違うトークンは失効できない (404)', async () => {
    // admin 宛のトークンを viewer の URL で失効させようとする
    const token = seed.a.tokenRows.admin;
    const wrongUser = await call(revokeToken, {
      token: seed.a.tokens.admin,
      method: 'DELETE',
      params: { userId: seed.a.users.viewer.id, tokenId: token.id },
    });
    expect(wrongUser.status).toBe(404);
    // 失効していない (行が書き換わらない)
    expect(seed.store.userTokens.get(token.id)?.revokedAt).toBeNull();
    // 正しい発行先なら失効できる
    const correct = await call(revokeToken, {
      token: seed.a.tokens.admin,
      method: 'DELETE',
      params: { userId: seed.a.users.admin.id, tokenId: token.id },
    });
    expect(correct.status).toBe(204);
  });

  it('無効化したユーザーの役割は変えられない (409。認証できない admin を作らない)', async () => {
    // viewer を無効化する
    const target = seed.a.users.viewer;
    expect(
      (
        await call(disableUser, {
          token: seed.a.tokens.admin,
          method: 'DELETE',
          params: { userId: target.id },
        })
      ).status,
    ).toBe(200);
    // 昇格も降格も 409 (トークン発行と同じ文言)
    for (const role of [Role.admin, Role.operator]) {
      const result = await call(updateRole, {
        token: seed.a.tokens.admin,
        method: 'PUT',
        params: { userId: target.id },
        body: { role },
      });
      expect(result.status, role).toBe(409);
      expect((result.json as { message: string }).message).toBe(API_MESSAGES.userDisabled);
    }
  });

  it('自分自身は無効化できない (409)', async () => {
    // admin が自分を指定する
    const result = await call(disableUser, {
      token: seed.a.tokens.admin,
      method: 'DELETE',
      params: { userId: seed.a.users.admin.id },
    });
    expect(result.status).toBe(409);
  });

  it('admin が 2 人なら片方を無効化でき、残った 1 人は自分自身を無効化できない (409)', async () => {
    // API 経路では「最後の admin」は必ず操作者自身になる (自分以外を無効化する時点で有効 admin は 2 人以上) ので、
    // ここで確かめる 409 は selfDisable。データ層の last_admin 判定そのものは契約テストと下の memory の経路で固定する
    await call(updateRole, {
      token: seed.a.tokens.admin,
      method: 'PUT',
      params: { userId: seed.a.users.operator.id },
      body: { role: Role.admin },
    });
    // operator (今は admin) が元の admin を無効化 → admin が 2 人なので 200
    const first = await call(disableUser, {
      token: seed.a.tokens.operator,
      method: 'DELETE',
      params: { userId: seed.a.users.admin.id },
    });
    expect(first.status).toBe(200);
    // 残った admin (元 operator) を、viewer を admin に昇格させずに消す手段は無い (自分自身は 409)
    const self = await call(disableUser, {
      token: seed.a.tokens.operator,
      method: 'DELETE',
      params: { userId: seed.a.users.operator.id },
    });
    expect(self.status).toBe(409);
  });

  it('無効化したユーザーにはトークンを発行できない (409)', async () => {
    // viewer を無効化してから発行を試みる
    await call(disableUser, {
      token: seed.a.tokens.admin,
      method: 'DELETE',
      params: { userId: seed.a.users.viewer.id },
    });
    const result = await call(createToken, {
      token: seed.a.tokens.admin,
      params: { userId: seed.a.users.viewer.id },
      body: { name: 'x' },
    });
    expect(result.status).toBe(409);
  });

  it('無効化は冪等 (2 回目も 200 で日時は変わらない)', async () => {
    // 1 回目
    const first = await call(disableUser, {
      token: seed.a.tokens.admin,
      method: 'DELETE',
      params: { userId: seed.a.users.viewer.id },
    });
    // 2 回目
    const second = await call(disableUser, {
      token: seed.a.tokens.admin,
      method: 'DELETE',
      params: { userId: seed.a.users.viewer.id },
    });
    expect(second.status).toBe(200);
    expect((second.json as { disabledAt: string }).disabledAt).toBe(
      (first.json as { disabledAt: string }).disabledAt,
    );
  });
});

describe('ログイントークン (/users/{userId}/tokens)', () => {
  it('admin は発行でき、平文は発行応答にだけ載る', async () => {
    // viewer 向けに発行する
    const issued = await call(createToken, {
      token: seed.a.tokens.admin,
      params: { userId: seed.a.users.viewer.id },
      body: { name: 'CLI' },
    });
    expect(issued.status).toBe(201);
    const body = issued.json as { id: string; secret: string; prefix: string; expiresAt: string };
    expect(body.secret.startsWith(USER_TOKEN_PREFIX)).toBe(true);
    // 発行したトークンで viewer として認証できる
    const me = await call(getMe, { token: body.secret });
    expect((me.json as { user: { id: string } }).user.id).toBe(seed.a.users.viewer.id);
    // 一覧には平文もハッシュも載らない
    const list = await call(listTokens, {
      token: seed.a.tokens.admin,
      params: { userId: seed.a.users.viewer.id },
    });
    expect(list.status).toBe(200);
    const text = JSON.stringify(list.json);
    expect(text).not.toContain(body.secret);
    expect(text).not.toContain('tokenHash');
    expect((list.json as { items: { id: string }[] }).items.map((t) => t.id)).toContain(body.id);
  });

  it('有効期間は既定 90 日で、365 日を超える指定は 422', async () => {
    // 既定
    const issued = await call(createToken, {
      token: seed.a.tokens.admin,
      params: { userId: seed.a.users.viewer.id },
      body: { name: '既定' },
    });
    const expiresAt = new Date((issued.json as { expiresAt: string }).expiresAt).getTime();
    const days = (expiresAt - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThanOrEqual(90);
    // 上限超え
    const tooLong = await call(createToken, {
      token: seed.a.tokens.admin,
      params: { userId: seed.a.users.viewer.id },
      body: { name: '長すぎ', expiresInDays: 366 },
    });
    expect(tooLong.status).toBe(422);
  });

  it('失効させると 401 になり、失効は冪等', async () => {
    // 発行
    const issued = await call(createToken, {
      token: seed.a.tokens.admin,
      params: { userId: seed.a.users.viewer.id },
      body: { name: '失効テスト' },
    });
    const body = issued.json as { id: string; secret: string };
    // 失効
    const revoked = await call(revokeToken, {
      token: seed.a.tokens.admin,
      method: 'DELETE',
      params: { userId: seed.a.users.viewer.id, tokenId: body.id },
    });
    expect(revoked.status).toBe(204);
    expect((await call(getMe, { token: body.secret })).status).toBe(401);
    // 2 回目も 204
    const again = await call(revokeToken, {
      token: seed.a.tokens.admin,
      method: 'DELETE',
      params: { userId: seed.a.users.viewer.id, tokenId: body.id },
    });
    expect(again.status).toBe(204);
  });

  it('他テナントのユーザーへの発行・一覧・失効は 404', async () => {
    // テナント B のユーザーをテナント A の admin が指定する
    const target = seed.b.users.viewer.id;
    expect(
      (
        await call(createToken, {
          token: seed.a.tokens.admin,
          params: { userId: target },
          body: { name: 'x' },
        })
      ).status,
    ).toBe(404);
    expect(
      (await call(listTokens, { token: seed.a.tokens.admin, params: { userId: target } })).status,
    ).toBe(404);
    expect(
      (
        await call(revokeToken, {
          token: seed.a.tokens.admin,
          method: 'DELETE',
          params: { userId: target, tokenId: seed.b.tokenRows.viewer.id },
        })
      ).status,
    ).toBe(404);
  });

  it('viewer / operator は発行できない (403)', async () => {
    // admin ロール限定
    for (const role of [Role.viewer, Role.operator]) {
      const result = await call(createToken, {
        token: seed.a.tokens[role],
        params: { userId: seed.a.users[role].id },
        body: { name: 'x' },
      });
      expect(result.status).toBe(403);
    }
  });
});

describe('memory アダプタの last_admin 判定 (API 経路では操作者自身が最後の admin になるため、データ層で固定する)', () => {
  it('唯一の有効な admin の降格・無効化は last_admin、admin を足せば通る', async () => {
    // seed のテナント A は admin 1 人
    const repos = await getRepos();
    expect(await repos.users.updateRole(seed.a.id, seed.a.users.admin.id, Role.viewer)).toEqual({
      status: 'last_admin',
    });
    expect(await repos.users.disable(seed.a.id, seed.a.users.admin.id)).toEqual({
      status: 'last_admin',
    });
    // operator を admin へ昇格させると、元の admin を降格できる
    expect(
      (await repos.users.updateRole(seed.a.id, seed.a.users.operator.id, Role.admin)).status,
    ).toBe('ok');
    expect(
      (await repos.users.updateRole(seed.a.id, seed.a.users.admin.id, Role.viewer)).status,
    ).toBe('ok');
  });
});
