// Vitest のテスト API
import { describe, expect, it } from 'vitest';
// ファイル読み込み (Node 標準)
import { readFileSync } from 'node:fs';
// パス結合 (Node 標準)
import { join } from 'node:path';
// YAML パーサ (OpenAPI 定義は YAML)
import { parse } from 'yaml';

// OpenAPI 定義の場所 (package.json の gen スクリプトと同じファイル)
const OPENAPI_PATH = join(process.cwd(), 'openapi', 'openapi.yaml');
// HTTP メソッドとして扱うキー
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

// 定義を読み込んで最小限の型を当てる
type Operation = {
  operationId?: string;
  tags?: string[];
  responses?: Record<string, unknown>;
  security?: unknown[];
};
type PathItem = Partial<Record<(typeof HTTP_METHODS)[number], Operation>>;
type Spec = { openapi: string; paths: Record<string, PathItem>; tags?: { name: string }[] };
const spec = parse(readFileSync(OPENAPI_PATH, 'utf8')) as Spec;

// 全オペレーションを (パス, メソッド, 定義) の並びに平坦化する
const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
  HTTP_METHODS.flatMap((method) => (item[method] ? [{ path, method, op: item[method]! }] : [])),
);

describe('OpenAPI 定義 (openapi/openapi.yaml)', () => {
  // 受け入れ基準「定義が存在する」を最低限の中身込みで固定する
  it('OpenAPI 3.1 で、パスが 1 つ以上ある (Step0 の受け入れ基準: 定義が存在する)', () => {
    // 版と最低限の中身を確認する
    expect(spec.openapi.startsWith('3.1')).toBe(true);
    expect(operations.length).toBeGreaterThan(0);
  });

  // 生成される型・クライアントの名前になる operationId を固定する
  it('全オペレーションに一意な operationId がある (生成される型・クライアントの名前になる)', () => {
    // operationId を集める
    const ids = operations.map(({ op }) => op.operationId);
    // 欠けが無いこと
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    // 重複が無いこと
    expect(new Set(ids).size).toBe(ids.length);
  });

  // 未宣言タグ (typo) を落とす
  it('全オペレーションのタグは tags 一覧に宣言されている', () => {
    // 宣言済みタグの集合
    const declared = new Set((spec.tags ?? []).map((tag) => tag.name));
    // 各オペレーションのタグが宣言済みであること
    for (const { path, method, op } of operations) {
      expect(op.tags?.length, `${method.toUpperCase()} ${path} にタグが無い`).toBeGreaterThan(0);
      for (const tag of op.tags ?? []) expect(declared.has(tag), `未宣言のタグ ${tag}`).toBe(true);
    }
  });

  // 書き込み系は RBAC 違反の 403 を契約に持つ
  it('認証が必要なオペレーションは 403 (権限違反) の応答を宣言している', () => {
    // 定義側が `security: []` で公開と宣言したオペレーションは対象外 (パス名の決め打ちで写しを持たない)
    for (const { path, method, op } of operations) {
      if (Array.isArray(op.security) && op.security.length === 0) continue;
      // 読み取り (GET) は 403 を持たなくてよい (テナント境界は 404 で隠す)。書き込み系は必須
      if (method === 'get') continue;
      expect(Object.keys(op.responses ?? {}), `${method.toUpperCase()} ${path}`).toContain('403');
    }
  });
});
