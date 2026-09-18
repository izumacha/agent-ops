// Vitest のテスト API
import { describe, expect, it } from 'vitest';
// ファイル読み込み (Node 標準)
import { existsSync, readFileSync } from 'node:fs';
// パス結合 (Node 標準)
import { join } from 'node:path';
// YAML パーサ (OpenAPI 定義は YAML)
import { parse } from 'yaml';
import {
  EMAIL_MAX_LENGTH,
  LONG_TEXT_MAX_LENGTH,
  PAGE_CURSOR_MAX_LENGTH,
  SHORT_TEXT_MAX_LENGTH,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  USER_TOKEN_DEFAULT_TTL_DAYS,
  USER_TOKEN_MAX_TTL_DAYS,
} from '@/lib/constants';
import { MICRO_USD_MAX } from '@/domain/money';

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
  requestBody?: unknown;
};
type PathItem = Partial<Record<(typeof HTTP_METHODS)[number], Operation>>;
type Spec = {
  openapi: string;
  paths: Record<string, PathItem>;
  tags?: { name: string }[];
  components: {
    parameters: Record<string, { schema: Record<string, unknown> }>;
    schemas: Record<string, { properties?: Record<string, Record<string, unknown>> }>;
  };
};
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

  // 認証が要る操作はすべて 403 を契約に持つ (書き込み系は RBAC 違反、読み取り系もプラットフォーム管理者トークンで
  // テナント内の資源を読もうとすると 403 になる。テナント境界そのものは 404 で隠すが、主体の種類違いは 403)
  it('認証が必要なオペレーションは 401 (認証失敗) と 403 (権限違反) の応答を宣言している', () => {
    // 定義側が `security: []` で公開と宣言したオペレーションは対象外 (パス名の決め打ちで写しを持たない)
    for (const { path, method, op } of operations) {
      if (Array.isArray(op.security) && op.security.length === 0) continue;
      const codes = Object.keys(op.responses ?? {});
      expect(codes, `${method.toUpperCase()} ${path}`).toContain('401');
      expect(codes, `${method.toUpperCase()} ${path}`).toContain('403');
    }
  });

  // 本文を受けるオペレーションは body.ts が返す 400 / 413 / 415 を契約に持つ
  it('本文を受けるオペレーションは 400 / 413 / 415 の応答を宣言している', () => {
    // requestBody を持つオペレーションだけが対象
    for (const { path, method, op } of operations) {
      if (op.requestBody === undefined) continue;
      const codes = Object.keys(op.responses ?? {});
      for (const code of ['400', '413', '415']) {
        expect(codes, `${method.toUpperCase()} ${path} に ${code} が無い`).toContain(code);
      }
    }
  });

  // 上限値の写しを固定する (OpenAPI 定義と constants.ts の両方に同じ数値があり、片方だけ変えても lint / typecheck は緑のため)
  it('一覧の limit / cursor とトークン有効期間の上限は constants.ts と一致する', () => {
    // Limit パラメータ
    const limit = spec.components.parameters.Limit.schema;
    expect(limit.default).toBe(PAGE_LIMIT_DEFAULT);
    expect(limit.maximum).toBe(PAGE_LIMIT_MAX);
    // Cursor パラメータ
    expect(spec.components.parameters.Cursor.schema.maxLength).toBe(PAGE_CURSOR_MAX_LENGTH);
    // トークン有効期間
    const expiresInDays = spec.components.schemas.UserTokenCreate.properties?.expiresInDays;
    expect(expiresInDays?.default).toBe(USER_TOKEN_DEFAULT_TTL_DAYS);
    expect(expiresInDays?.maximum).toBe(USER_TOKEN_MAX_TTL_DAYS);
  });

  // 契約に載っているオペレーションが実装されていることを機械的に確かめる (ADR-0003 の「定義 → gen → 実装」のうち
  // 「実装」だけ検査が無く、パスを足し忘れる / ルートを改名すると契約だけが 404 を約束し続ける)
  it('契約の全オペレーションに対応する Route Handler がある', () => {
    // OpenAPI のパス (servers.url が /api/v1 なので、src/app/api/v1 配下に対応する)
    for (const [path, item] of Object.entries(spec.paths)) {
      // {param} を Next.js の [param] に置き換えたディレクトリ
      const dir = join(
        process.cwd(),
        'src',
        'app',
        'api',
        'v1',
        ...path
          .slice(1)
          .split('/')
          .map((segment) => segment.replace(/^\{(.+)\}$/, '[$1]')),
      );
      // ルートファイル
      const file = join(dir, 'route.ts');
      expect(existsSync(file), `${path} の Route Handler (${file}) が無い`).toBe(true);
      // 宣言されたメソッドが export されていること (大文字の名前付き export)
      const source = readFileSync(file, 'utf8');
      for (const method of HTTP_METHODS) {
        // 契約に無いメソッドは見ない
        if (!(method in item)) continue;
        // `export const GET = route(...)` でも `export async function GET(...)` でもよい
        expect(source, `${method.toUpperCase()} ${path} の export が無い`).toMatch(
          new RegExp(`export (?:const|(?:async )?function) ${method.toUpperCase()}\\b`),
        );
      }
    }
  });

  // 上の表に載せ忘れた maxLength が野放しにならないようにする (包含リストだけだと、表に無いプロパティは
  // 定数を変えても古い値のまま残り、契約と実装が食い違ったまま緑になる)
  it('本文スキーマの maxLength は既知の定数のいずれかである', () => {
    // 許す値 (文字列長の 3 種 + 予算の桁数)
    const allowed = new Set([
      SHORT_TEXT_MAX_LENGTH,
      LONG_TEXT_MAX_LENGTH,
      EMAIL_MAX_LENGTH,
      MICRO_USD_MAX.toString().length,
    ]);
    // components.schemas のプロパティを走査する
    for (const [schemaName, schema] of Object.entries(spec.components.schemas)) {
      for (const [property, definition] of Object.entries(schema.properties ?? {})) {
        // maxLength を宣言していないプロパティは対象外
        const max = (definition as { maxLength?: number }).maxLength;
        if (max === undefined) continue;
        // 既知の定数のいずれかであること
        expect(
          allowed.has(max),
          `${schemaName}.${property} の maxLength ${max} は定数由来でない`,
        ).toBe(true);
      }
    }
  });

  // 文字列長の上限も同じ理由で固定する (Zod 側は constants.ts を読むので、OpenAPI だけ動かすと
  // 「契約上は通る値が 422 になる」ずれが lint / typecheck / テスト緑のまま出荷される)
  it('本文スキーマの文字列長の上限は constants.ts と一致する', () => {
    // 期待する上限 (スキーマ名 → プロパティ名 → 定数)
    const expected: Record<string, Record<string, number>> = {
      TenantCreate: {
        name: SHORT_TEXT_MAX_LENGTH,
        adminEmail: EMAIL_MAX_LENGTH,
        adminName: SHORT_TEXT_MAX_LENGTH,
      },
      UserCreate: { email: EMAIL_MAX_LENGTH, name: SHORT_TEXT_MAX_LENGTH },
      UserTokenCreate: { name: SHORT_TEXT_MAX_LENGTH },
      AgentCreate: {
        name: SHORT_TEXT_MAX_LENGTH,
        description: LONG_TEXT_MAX_LENGTH,
        model: SHORT_TEXT_MAX_LENGTH,
      },
      AgentUpdate: {
        name: SHORT_TEXT_MAX_LENGTH,
        description: LONG_TEXT_MAX_LENGTH,
        model: SHORT_TEXT_MAX_LENGTH,
      },
      ApiKeyCreate: { name: SHORT_TEXT_MAX_LENGTH },
    };
    // スキーマごとに宣言された maxLength を突き合わせる
    for (const [schemaName, properties] of Object.entries(expected)) {
      for (const [property, max] of Object.entries(properties)) {
        const declared = spec.components.schemas[schemaName]?.properties?.[property]?.maxLength;
        expect(declared, `${schemaName}.${property} の maxLength`).toBe(max);
      }
    }
  });
});
