// エージェント API: 登録・取得・更新・削除・停止・復帰、入力検証、本文の防御、テナント境界、ページネーション
import { describe, expect, it, vi } from 'vitest';
import { GET as listAgents, POST as createAgent } from '@/app/api/v1/agents/route';
import {
  DELETE as deleteAgent,
  GET as getAgent,
  PATCH as updateAgent,
} from '@/app/api/v1/agents/[agentId]/route';
import { POST as resumeAgent } from '@/app/api/v1/agents/[agentId]/resume/route';
import { POST as stopAgent } from '@/app/api/v1/agents/[agentId]/stop/route';
import { decodeCursor, encodeCursor } from '@/data/page';
import { AgentStatus, Provider } from '@/domain/types';
import {
  API_MESSAGES,
  JSON_BODY_MAX_BYTES,
  LONG_TEXT_MAX_LENGTH,
  PAGE_CURSOR_MAX_LENGTH,
  SHORT_TEXT_MAX_LENGTH,
} from '@/lib/constants';
import { call, seedEachTest } from './helpers';

// seed (各テストで作り直し、後始末も helpers が行う)
const seed = seedEachTest();

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

  it('予算が BIGINT の範囲を超える・20 桁・負数・小数・数値型なら 422 (範囲外の文言は 1 種類)', async () => {
    // 範囲超え (19 桁) / 20 桁 / 負数 / 小数 / 数値型
    for (const budgetMicroUsd of [
      '9223372036854775808',
      '10000000000000000000',
      '-1',
      '1.5',
      100,
    ]) {
      const result = await call(createAgent, {
        token: seed.a.tokens.operator,
        body: { ...VALID, budgetMicroUsd },
      });
      expect(result.status, String(budgetMicroUsd)).toBe(422);
      // 文字列で形が違う・範囲外のときは、桁数によらず同じ文言 (数値型は型エラーの文言)
      if (typeof budgetMicroUsd === 'string') {
        const issues = (result.json as { issues: { path: string; message: string }[] }).issues;
        expect(issues[0].path).toBe('budgetMicroUsd');
        expect(issues[0].message).toBe(API_MESSAGES.microUsdOutOfRange);
      }
    }
  });

  it('未知のキーを含む本文は 422 (status は stop / resume でしか変えられない)', async () => {
    // 登録の本文に API が受け付けないキーを混ぜる
    const created = await call(createAgent, {
      token: seed.a.tokens.operator,
      body: { ...VALID, status: AgentStatus.stopped },
    });
    expect(created.status).toBe(422);
  });

  it('空白だけの名前は 422 で、前後の空白は除いて保存する', async () => {
    // 空白だけ
    expect(
      (await call(createAgent, { token: seed.a.tokens.operator, body: { ...VALID, name: '   ' } }))
        .status,
    ).toBe(422);
    // 末尾空白は除かれるので、既存の名前と重複する
    expect(
      (
        await call(createAgent, {
          token: seed.a.tokens.operator,
          body: { ...VALID, name: `${seed.a.agent.name} ` },
        })
      ).status,
    ).toBe(422);
  });

  it('空白だけの説明文は 422 (未設定は省略か null で表す)', async () => {
    // 登録
    const created = await call(createAgent, {
      token: seed.a.tokens.operator,
      body: { ...VALID, description: '   ' },
    });
    expect(created.status).toBe(422);
    expect((created.json as { issues: { path: string }[] }).issues.map((i) => i.path)).toEqual([
      'description',
    ]);
    // 更新 ('' も同じく弾き、null は通る)
    const updatedEmpty = await call(updateAgent, {
      token: seed.a.tokens.operator,
      method: 'PATCH',
      params: { agentId: seed.a.agent.id },
      body: { description: '' },
    });
    expect(updatedEmpty.status).toBe(422);
    const updatedNull = await call(updateAgent, {
      token: seed.a.tokens.operator,
      method: 'PATCH',
      params: { agentId: seed.a.agent.id },
      body: { description: null },
    });
    expect(updatedNull.status).toBe(200);
    expect((updatedNull.json as { description: string | null }).description).toBeNull();
    // モデル名の更新も反映されること (どの項目も「送ったのに 200 のまま変わらない」が起きないよう往復させる)
    const updatedModel = await call(updateAgent, {
      token: seed.a.tokens.operator,
      method: 'PATCH',
      params: { agentId: seed.a.agent.id },
      body: { model: 'claude-opus-4-1' },
    });
    expect(updatedModel.status).toBe(200);
    expect((updatedModel.json as { model: string }).model).toBe('claude-opus-4-1');
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

  it('UTF-8 として不正なバイト列を含む本文は 400 (置換して保存しない)', async () => {
    // 有効な JSON の途中に不正なバイト (0xFF 0xFE) を混ぜる
    const head = Buffer.from('{"name":"bad-', 'utf8');
    const tail = Buffer.from('","provider":"anthropic","model":"m"}', 'utf8');
    const body = Buffer.concat([head, Buffer.from([0xff, 0xfe]), tail]);
    const result = await call(createAgent, {
      token: seed.a.tokens.operator,
      method: 'POST',
      rawBody: body,
      headers: { 'content-type': 'application/json' },
    });
    expect(result.status).toBe(400);
    // 保存されていない
    expect([...seed.store.agents.values()].some((a) => a.name.startsWith('bad-'))).toBe(false);
  });

  it('送信途中でクライアントが切断した本文は 400 (500 と障害ログにしない)', async () => {
    // 読むと Node の切断エラー (code = ECONNRESET) で失敗するストリーム
    const reset = Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
    const disconnected = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(reset);
      },
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await call(createAgent, {
        token: seed.a.tokens.operator,
        method: 'POST',
        rawBody: disconnected,
        headers: { 'content-type': 'application/json' },
      });
      expect(result.status).toBe(400);
      // 障害ログは積まれない
      expect(errorSpy).not.toHaveBeenCalled();
      // 切断以外の読み取り失敗はこれまでどおり内部エラー (500) として記録する。message は複数行で利用者の入力
      // (メールアドレス) を含む形にし、ログに残らないことを確かめる (ORM の検証エラーがこの形。§9)
      // 「at 」で始まる行 (利用者の入力が改行を含めば作れる) もフレームとして残らないこと
      const leakyMessage =
        'disk failure\nInvalid invocation:\n{ email: "alice@example.com" }\nat alice@example.com\nat evil (/etc/passwd:1:1)';
      const broken = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error(leakyMessage));
        },
      });
      const other = await call(createAgent, {
        token: seed.a.tokens.operator,
        method: 'POST',
        rawBody: broken,
        headers: { 'content-type': 'application/json' },
      });
      expect(other.status).toBe(500);
      // 応答の本文は定型の日本語メッセージだけ (内部詳細・利用者の入力を外へ返さない。§9)。
      // ログの検査だけだと、応答へ String(error) を載せる変更が全件緑のまま通る
      expect(other.json).toEqual({ status: 500, message: API_MESSAGES.internal });
      expect(errorSpy).toHaveBeenCalledTimes(1);
      // ログには種類と発生箇所だけが残り、message (利用者の入力) は 1 文字も残らない
      const logged = JSON.stringify(errorSpy.mock.calls[0]);
      expect(logged).toContain('"name":"Error"');
      // 本物のフレーム (このテストの pull 関数) は残る
      expect(logged).toMatch(/at (?:Object\.)?pull /);
      expect(logged).not.toContain('alice@example.com');
      expect(logged).not.toContain('disk failure');
      // message に仕込んだ「フレームの形をした行」も残らない (偽の発生箇所を障害ログへ書けない)
      expect(logged).not.toContain('/etc/passwd');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('文字列の長さ上限は実際に効く (上限ちょうどは通り、1 文字超えると 422)', async () => {
    // 上限ちょうどの名前は受け付ける (上限を厳しくしすぎる変更もここで落ちる)
    const atLimit = await call(createAgent, {
      token: seed.a.tokens.operator,
      body: { ...VALID, name: 'a'.repeat(SHORT_TEXT_MAX_LENGTH) },
    });
    expect(atLimit.status).toBe(201);
    // 1 文字超えた名前は 422 (Zod の .max() を外すと DB の列長で 500 になるか、そのまま保存される)
    const tooLongName = await call(createAgent, {
      token: seed.a.tokens.operator,
      body: { ...VALID, name: 'b'.repeat(SHORT_TEXT_MAX_LENGTH + 1) },
    });
    expect(tooLongName.status).toBe(422);
    expect((tooLongName.json as { issues: { path: string }[] }).issues[0].path).toBe('name');
    // 説明文 (長い方の上限) も同じ
    const tooLongDescription = await call(createAgent, {
      token: seed.a.tokens.operator,
      body: { ...VALID, name: '別の名前', description: 'c'.repeat(LONG_TEXT_MAX_LENGTH + 1) },
    });
    expect(tooLongDescription.status).toBe(422);
    expect((tooLongDescription.json as { issues: { path: string }[] }).issues[0].path).toBe(
      'description',
    );
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

  it('申告サイズが上限を超えていれば本文を読む前に 413 (実測は上限内でも申告で弾く)', async () => {
    // 本文そのものは上限内で、そのまま読めば 201 になる正しい JSON
    const result = await call(createAgent, {
      token: seed.a.tokens.operator,
      method: 'POST',
      rawBody: JSON.stringify(VALID),
      headers: {
        'content-type': 'application/json',
        'content-length': String(JSON_BODY_MAX_BYTES + 1),
      },
    });
    // 申告サイズだけを見て 413 (この経路が無いと本文が通って 201 になる)
    expect(result.status).toBe(413);
    // 保存されていない
    expect([...seed.store.agents.values()].filter((a) => a.name === VALID.name)).toHaveLength(0);
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
    // 未知の状態は 422。limit の誤りと同時なら 1 応答の issues に両方載る
    const invalid = await call(listAgents, {
      token: seed.a.tokens.viewer,
      query: 'status=x&limit=0',
    });
    expect(invalid.status).toBe(422);
    expect(
      (invalid.json as { issues: { path: string }[] }).issues.map((i) => i.path).sort(),
    ).toEqual(['limit', 'status']);
  });

  it('カーソルでページ送りでき、カーソル行が削除されても続きが取れ、壊れたカーソルは 422', async () => {
    // 合計 3 件にする
    await call(createAgent, { token: seed.a.tokens.operator, body: { ...VALID, name: 'b' } });
    await call(createAgent, { token: seed.a.tokens.operator, body: { ...VALID, name: 'c' } });
    // 2 件ずつ
    const page1 = (await call(listAgents, { token: seed.a.tokens.viewer, query: 'limit=2' }))
      .json as { items: { id: string }[]; nextCursor?: string };
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();
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
    // カーソル行 (page1 の最終行) を削除しても、そのカーソルで続き (3 件目) が取れる
    await call(deleteAgent, {
      token: seed.a.tokens.admin,
      method: 'DELETE',
      params: { agentId: page1.items[1].id },
    });
    const afterDelete = (
      await call(listAgents, {
        token: seed.a.tokens.viewer,
        query: `limit=2&cursor=${page1.nextCursor}`,
      })
    ).json as { items: { id: string }[] };
    expect(afterDelete.items.map((a) => a.id)).toEqual(page2.items.map((a) => a.id));
    // 壊れたカーソルは 422 (issues.path = cursor)。空文字も同じ原因 (形が違う) なので同じ文言
    for (const query of [
      'cursor=nope',
      'cursor=',
      `cursor=${'a'.repeat(PAGE_CURSOR_MAX_LENGTH + 1)}`,
    ]) {
      const broken = await call(listAgents, { token: seed.a.tokens.viewer, query });
      expect(broken.status, query).toBe(422);
      const issues = (broken.json as { issues: { path: string; message: string }[] }).issues;
      expect(issues[0].path).toBe('cursor');
      expect(issues[0].message).toBe(API_MESSAGES.invalidCursor);
    }
  });

  it('範囲外の limit は桁数によらず範囲の文言で 422 (7 桁以上も「10 進の整数で」にならない)', async () => {
    // 上限超過を 3 桁と 7 桁で試す
    for (const limit of ['201', '1000000']) {
      const result = await call(listAgents, {
        token: seed.a.tokens.viewer,
        query: `limit=${limit}`,
      });
      expect(result.status, limit).toBe(422);
      const message = (result.json as { issues: { path: string; message: string }[] }).issues[0];
      expect(message.path).toBe('limit');
      // 形の誤り (10 進の整数で指定してください) ではなく範囲の誤りであること
      expect(message.message, limit).not.toBe(API_MESSAGES.invalidLimit);
    }
    // 形の誤りはこれまでどおり invalidLimit
    const malformed = await call(listAgents, { token: seed.a.tokens.viewer, query: 'limit=0x10' });
    expect((malformed.json as { issues: { message: string }[] }).issues[0].message).toBe(
      API_MESSAGES.invalidLimit,
    );
  });

  it('復号できる形でも上限より長い cursor は 422 (復号前に長さで弾く)', async () => {
    // 正しい位置を符号化したカーソル (これ単体なら復号できる)
    const valid = encodeCursor({ createdAt: new Date(), id: seed.a.agent.id });
    // base64 の復号は英数字・- ・ _ 以外を読み飛ばすので、前に '!' を並べても復号結果は変わらない。
    // 「長さの検査を外すと通ってしまう」形 = 形の検査では落ちないカーソルを作る
    const cursor = '!'.repeat(PAGE_CURSOR_MAX_LENGTH) + valid;
    // 上限より長いこと (テストの前提)
    expect(cursor.length).toBeGreaterThan(PAGE_CURSOR_MAX_LENGTH);
    // 形の検査では落ちないこと (この前提が崩れると、長さの検査を消しても 422 のままになり検査が空回りする)
    expect(decodeCursor(cursor)).not.toBeNull();
    const result = await call(listAgents, {
      token: seed.a.tokens.viewer,
      query: `cursor=${cursor}`,
    });
    expect(result.status).toBe(422);
    const issues = (result.json as { issues: { path: string; message: string }[] }).issues;
    expect(issues[0].path).toBe('cursor');
    expect(issues[0].message).toBe(API_MESSAGES.invalidCursor);
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

  it('未知のキーを含む本文は 422 (黙って剥がして無視しない)', async () => {
    // 更新: provider は変えられない
    const updated = await call(updateAgent, {
      token: seed.a.tokens.operator,
      method: 'PATCH',
      params: { agentId: seed.a.agent.id },
      body: { name: '新しい名前', provider: Provider.openai },
    });
    expect(updated.status).toBe(422);
    // 元の名前のまま (剥がして部分的に適用していない)
    expect(seed.store.agents.get(seed.a.agent.id)?.name).toBe(seed.a.agent.name);
  });

  it('空の本文は 422 (何も変えない更新で updatedAt だけ進めない)', async () => {
    // 1 つも指定が無い PATCH
    const result = await call(updateAgent, {
      token: seed.a.tokens.operator,
      method: 'PATCH',
      params: { agentId: seed.a.agent.id },
      body: {},
    });
    expect(result.status).toBe(422);
    expect((result.json as { issues: { message: string }[] }).issues[0].message).toBe(
      API_MESSAGES.emptyPatch,
    );
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

describe('本文の上限はストリームで数える (Content-Length を偽っても 413)', () => {
  it('Content-Length を小さく偽った巨大本文でも 413 になり、全量を読み切らない', async () => {
    // 上限を超える本文を、申告サイズだけ小さくして送る
    const payload = JSON.stringify({ ...VALID, description: 'a'.repeat(JSON_BODY_MAX_BYTES) });
    const result = await call(createAgent, {
      token: seed.a.tokens.operator,
      method: 'POST',
      rawBody: payload,
      headers: { 'content-type': 'application/json', 'content-length': '10' },
    });
    expect(result.status).toBe(413);
  });
});
