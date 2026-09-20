// Vitest のテスト API
import { describe, expect, it } from 'vitest';
// ファイル読み込み (Node 標準)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
// パス結合 (Node 標準)
import { join } from 'node:path';
// YAML パーサ (OpenAPI 定義は YAML)
import { parse } from 'yaml';
import { ALLOWED_ROUTE_FILE_NAME, ROUTE_FILE_PATTERN } from './lib/route-files';
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
import { RESOURCE_ID_MAX_LENGTH } from '@/domain/resource-id';
import type { ZodObject, ZodTypeAny } from 'zod';
import { agentCreateSchema, agentUpdateSchema } from '@/lib/validations/agent';
import { apiKeyCreateSchema } from '@/lib/validations/api-key';
import { tenantCreateSchema } from '@/lib/validations/tenant';
import { userTokenCreateSchema } from '@/lib/validations/user-token';
import { userCreateSchema, userRoleSchema } from '@/lib/validations/user';
import { proxyRequestSchema } from '@/lib/validations/proxy';

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
  requestBody?: {
    content?: Record<
      string,
      { schema?: { $ref?: string; properties?: Record<string, Record<string, unknown>> } }
    >;
  };
};
type PathItem = Partial<Record<(typeof HTTP_METHODS)[number], Operation>>;
type SchemaObject = {
  type?: unknown;
  maxLength?: number;
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  additionalProperties?: unknown;
  required?: string[];
  allOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  // 上に挙げていないキーワード (description / default / maximum など) もそのまま読めるようにする
  [keyword: string]: unknown;
};
type Spec = {
  openapi: string;
  paths: Record<string, PathItem>;
  tags?: { name: string }[];
  components: {
    parameters: Record<string, { schema: Record<string, unknown> }>;
    schemas: Record<string, SchemaObject>;
    responses?: Record<string, unknown>;
  };
};
const spec = parse(readFileSync(OPENAPI_PATH, 'utf8')) as Spec;

// 契約の本文スキーマ → 実装の Zod スキーマ。表に載っていない本文が契約に増えれば下のテストが落ちるので、
// 「対応を書き忘れたまま契約と実装が食い違う」ことが起きない (キーは $ref の名前、インラインは "METHOD /path")
const BODY_SCHEMAS: Record<string, ZodObject<Record<string, ZodTypeAny>>> = {
  TenantCreate: tenantCreateSchema,
  UserCreate: userCreateSchema,
  UserTokenCreate: userTokenCreateSchema,
  AgentCreate: agentCreateSchema,
  AgentUpdate: agentUpdateSchema,
  ApiKeyCreate: apiKeyCreateSchema,
  'PUT /users/{userId}/role': userRoleSchema,
  ProxyRequest: proxyRequestSchema,
};

// **未知キーを許すことが意図である本文の除外表 (理由付き)。**
// 原則は「契約も Zod も未知キーを閉じる」で、ここに載せた本文だけが例外。
// エントリが増える差分は、理由の妥当性をレビューで必ず確認する (この表は機械化できないエスケープハッチ)。
// 除外しても項目の一致 (契約の properties と Zod の shape) と「必須項目が実際に必須か」は下のテストが見る
const OPEN_BODY_SCHEMAS: Record<string, string> = {
  ProxyRequest:
    'ベンダー (Anthropic / OpenAI) のペイロードをそのまま中継するため。未知キーを 422 にすると、' +
    'ベンダーが新しいパラメータを足しただけで中継が止まる (docs/adr/0007-cost-proxy.md)',
};

// 契約に現れる本文スキーマを (キー, 定義) の並びで集める ($ref は components から解決する)
function collectRequestBodies(): {
  key: string;
  schema: { properties?: Record<string, Record<string, unknown>>; additionalProperties?: unknown };
}[] {
  // パス × メソッドを走査する
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    HTTP_METHODS.flatMap((method) => {
      // JSON の本文スキーマ
      const declared = item[method]?.requestBody?.content?.['application/json']?.schema;
      if (!declared) return [];
      // $ref なら components から引き、名前をキーにする
      if (declared.$ref) {
        const name = refName(declared.$ref);
        return [{ key: name, schema: spec.components.schemas[name] }];
      }
      // インライン定義はメソッドとパスをキーにする
      return [{ key: `${method.toUpperCase()} ${path}`, schema: declared }];
    }),
  );
}

// $ref が components を指すときの接頭辞
const COMPONENT_REF_PREFIX = '#/components/';

// $ref からスキーマ名を取り出す (末尾の 1 語が名前)
function refName(ref: string): string {
  // '#/components/schemas/Agent' → 'Agent'
  return ref.split('/').pop() as string;
}

// 入れ子のどこにあっても components への $ref を集める (応答は content / 配列 / 合成の下に隠れる)。
// schemas 以外 (responses など) も拾うのが要点 — 応答は components.responses 経由で書かれることが多く、
// schemas だけを拾うと「共通の応答へ括り出す」ふつうのリファクタでスキーマが静かに走査から外れる
function componentRefsIn(node: unknown): string[] {
  // 配列は要素ごとに潜る
  if (Array.isArray(node)) return node.flatMap(componentRefsIn);
  // オブジェクト以外は参照を持たない
  if (node === null || typeof node !== 'object') return [];
  // キーが $ref で components を指していればその参照を拾い、そうでなければ値の中へ潜る
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    key === '$ref' && typeof value === 'string' && value.startsWith(COMPONENT_REF_PREFIX)
      ? [value]
      : componentRefsIn(value),
  );
}

// $ref を components の実体へ解決する (解決できなければ undefined)
function resolveComponentRef(ref: string): unknown {
  // '#/components/<section>/<name>' を節と名前に分ける
  const [, , section, name] = ref.split('/');
  // 節ごとの表から引く
  return (spec.components as unknown as Record<string, Record<string, unknown> | undefined>)[
    section
  ]?.[name];
}

// 与えた起点から到達できるスキーマ名を推移的に集める。
// 「本文を除外する」のではなく「応答だけを対象にする」ので、本文専用だったスキーマを応答にも
// 使い始めた瞬間に検査対象へ入る (除外側で名前を並べると、その瞬間に静かに外れる)
function collectSchemaNamesFrom(roots: unknown[]): Set<string> {
  // これから中を見る定義
  const pending = [...roots];
  // 既に辿った参照 (循環で止まらなくなるのを防ぐ)
  const visited = new Set<string>();
  // 集めたスキーマ名
  const found = new Set<string>();
  // 参照をたどり尽くすまで繰り返す
  while (pending.length > 0) {
    // 次の定義の中にある参照をすべて見る
    for (const ref of componentRefsIn(pending.pop())) {
      // 既に辿った参照は飛ばす
      if (visited.has(ref)) continue;
      visited.add(ref);
      // 参照先の実体
      const resolved = resolveComponentRef(ref);
      // 解決できない参照はそこから先が丸ごと走査から落ちるので落とす (fail-closed)。
      // この 1 行自体を消しても壊れた $ref は `npm run gen` が必ず落とすので、担保は二重になっている
      expect(resolved, `${ref} を解決できない`).toBeDefined();
      // スキーマを指す参照なら名前を集める (それ以外の節は解決先へ潜るだけ)
      if (ref.startsWith(`${COMPONENT_REF_PREFIX}schemas/`)) found.add(refName(ref));
      // 参照先の中身も辿る
      pending.push(resolved);
    }
  }
  // 到達できたスキーマ名
  return found;
}

// 応答として使われるスキーマ名 (全オペレーションの responses が起点)
function collectResponseSchemaNames(): Set<string> {
  // 各オペレーションの応答宣言から辿る
  return collectSchemaNamesFrom(operations.map(({ op }) => op.responses ?? {}));
}

// スキーマ本体と allOf / oneOf / anyOf の枝を平坦に並べる (枝は入れ子にできるので再帰する)。
// $ref だけの枝は properties を持たないので何も足さない (参照先はそれ自身が走査対象になる)
function objectBranches(schema: SchemaObject): SchemaObject[] {
  // 合成の枝 (allOf / oneOf / anyOf)
  const composed = [...(schema.allOf ?? []), ...(schema.oneOf ?? []), ...(schema.anyOf ?? [])];
  // その場で書かれた入れ子のオブジェクト (プロパティの値と配列の要素)。$ref の枝は参照先自身が
  // 走査対象になるので何も足さない。ここへ降りないと、入れ子の中の null 許容が検査から漏れる
  // (実際 Error.issues.items のような「配列の要素として直接書いたオブジェクト」が素通りしていた)
  const nested = [
    ...Object.values(schema.properties ?? {}),
    ...(schema.items ? [schema.items] : []),
  ];
  // 自分自身と、枝・入れ子をそれぞれ展開したもの
  return [schema, ...[...composed, ...nested].flatMap(objectBranches)];
}

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

  // 走査が拾うメソッドの外へオペレーションを足すと、401 / 403 / 500 の宣言検査を含む
  // この検査一式から静かに外れる。パス項目のキーが既知のものだけであることを固定する
  it('パス項目に未知のキー (走査しないメソッド) が無い', () => {
    // オペレーション以外に書けるキー (OpenAPI 3.1 のパス項目)
    const nonOperationKeys = ['summary', 'description', 'servers', 'parameters', '$ref'];
    // 許すキーの集合
    const allowed = new Set<string>([...HTTP_METHODS, ...nonOperationKeys]);
    // パスごとにキーを確かめる
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const key of Object.keys(item)) {
        expect(allowed.has(key), `${path} の ${key} は走査対象外`).toBe(true);
      }
    }
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
      // 500 はどのルートでも起こりうる (route() が予期しない例外をここへ落とす) ので契約にも載せる
      expect(codes, `${method.toUpperCase()} ${path}`).toContain('500');
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

  // 逆方向 (実装 → 契約) も見る。契約に無い Route Handler は 401/403 等の宣言検査も型生成も掛からないまま出荷される
  it('src/app/api/v1 配下の Route Handler はすべて契約に載っている', () => {
    // ルートの入口 (OpenAPI の servers.url に対応するディレクトリ)
    const root = join(process.cwd(), 'src', 'app', 'api', 'v1');
    // route.ts を再帰で集め、ディレクトリ名から契約のパスへ戻す
    const found: string[] = [];
    const walk = (dir: string, segments: string[]): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        // 下位ディレクトリへ潜る
        if (entry.isDirectory()) {
          walk(join(dir, entry.name), [...segments, entry.name.replace(/^\[(.+)\]$/, '{$1}')]);
          continue;
        }
        // Route Handler のファイルがあればその位置が 1 つのパス (拡張子の違いも拾う。
        // route.ts に決め打ちすると route.tsx / route.js が検査の外へ落ちる)
        if (ROUTE_FILE_PATTERN.test(entry.name)) found.push(`/${segments.join('/')}`);
      }
    };
    walk(root, []);
    // 1 つも見つからなければ検査が効いていないので落とす (fail-closed)
    expect(found.length).toBeGreaterThan(0);
    // すべて契約に載っていること
    for (const path of found) {
      expect(Object.keys(spec.paths), `${path} が openapi.yaml に無い`).toContain(path);
    }
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
      // ルートファイル (綴りは tests/route-wrapping.test.ts が route.ts に固定している)
      const file = join(dir, ALLOWED_ROUTE_FILE_NAME);
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

  // 予算の上限値は説明文にも書いてあるので、定数と一致することを固定する (散文の写しだけが古くなるのを防ぐ)
  it('予算の説明に書いた上限は MICRO_USD_MAX と一致する', () => {
    // 上限を含む説明を持つプロパティ (登録・更新の両方)
    for (const schemaName of ['AgentCreate', 'AgentUpdate']) {
      const description = spec.components.schemas[schemaName]?.properties?.budgetMicroUsd
        ?.description as string | undefined;
      expect(description, `${schemaName}.budgetMicroUsd に説明が無い`).toBeDefined();
      expect(description, `${schemaName}.budgetMicroUsd の上限`).toContain(
        MICRO_USD_MAX.toString(),
      );
      // 「19 桁まで」の桁数も定数から導く (散文の片方だけが古くなるのを防ぐ)
      expect(description, `${schemaName}.budgetMicroUsd の桁数`).toContain(
        `${MICRO_USD_MAX.toString().length} 桁`,
      );
    }
  });

  // 本文は契約と Zod の両方で未知キーを閉じ、受け付ける項目も一致させる (どちらか片方だけが厳しいと
  // 「契約上は妥当な本文が 422」/「契約が禁じた本文が 200」になる。走査は契約側から導くので、
  // インラインの本文や将来足したパスも自動で対象に入る)
  it('本文スキーマは契約と Zod で項目が一致し、両方が未知キーを閉じている', () => {
    // 契約に現れる本文を全部集める
    const bodies = collectRequestBodies();
    // 1 つも集められなければ走査が壊れている (fail-closed)
    expect(bodies.length).toBeGreaterThan(0);
    for (const { key, schema } of bodies) {
      // 未知キーを許すことが意図である本文 (除外表に理由付きで載っているもの) かどうか
      const openReason = OPEN_BODY_SCHEMAS[key];
      // 契約側が未知キーを閉じていること (除外した本文は逆に「開いている」ことを確かめる —
      // 除外したまま閉じると、実装だけが通す形になって契約と食い違う)
      expect(schema?.additionalProperties, `${key} の未知キーの扱い`).toBe(
        openReason === undefined ? false : true,
      );
      // 対応する Zod スキーマが表にあること (契約に本文が増えたら必ずここで落ちる)
      const zodSchema = BODY_SCHEMAS[key];
      expect(zodSchema, `${key} に対応する Zod スキーマが表に無い`).toBeDefined();
      if (!zodSchema) continue;
      // 受け付ける項目が一致すること
      expect(Object.keys(zodSchema.shape).sort(), `${key} の項目`).toEqual(
        Object.keys(schema.properties ?? {}).sort(),
      );
      // 除外した本文は「未知キーを通す」ことだけを確かめて次へ (必須項目の検査は下の専用テスト)
      if (openReason !== undefined) continue;
      // Zod 側も未知キーを拒否すること (z.object へ戻すとここで落ちる)
      const parsed = zodSchema.safeParse({ __unknown__: 1 });
      expect(parsed.success, `${key} は未知キーを受け入れてしまう`).toBe(false);
      if (!parsed.success) {
        expect(
          parsed.error.issues.some((issue) => issue.code === 'unrecognized_keys'),
          `${key} が未知キーを剥がしている`,
        ).toBe(true);
      }
    }
  });

  // 除外表そのものを見張る (実在しないキーを足して検査を緩められないようにする)
  it('未知キーを許す本文の除外表は、実在する本文に理由付きで載っている', () => {
    // 契約に現れる本文のキー
    const keys = new Set(collectRequestBodies().map((body) => body.key));
    // 除外表の各エントリ
    for (const [key, reason] of Object.entries(OPEN_BODY_SCHEMAS)) {
      // 契約に実在する本文であること (消えた本文の除外が残り続けない)
      expect(keys.has(key), `除外表の ${key} が契約に無い`).toBe(true);
      // 理由が空でないこと (「とりあえず黙らせる」使い方を塞ぐ)
      expect(reason.trim().length, `${key} の除外理由が空`).toBeGreaterThan(0);
    }
  });

  // 除外した本文でも「計測に必要な項目」は必須のままであること。
  // 未知キーを許した瞬間に model まで任意になると、料金表を引けない呼び出しが中継できてしまう
  it('未知キーを許す本文でも、契約の required は Zod でも必須になっている', () => {
    // 契約に現れる本文を名前で引けるようにする
    const bodies = new Map(collectRequestBodies().map((body) => [body.key, body.schema]));
    for (const key of Object.keys(OPEN_BODY_SCHEMAS)) {
      // 契約側の必須項目 (required)
      const required = ((bodies.get(key) as { required?: string[] } | undefined)?.required ??
        []) as string[];
      // 必須項目が 1 つも無ければこの検査は意味を持たないので落とす (fail-closed)
      expect(required.length, `${key} に required が無い`).toBeGreaterThan(0);
      // 実装の Zod スキーマ
      const zodSchema = BODY_SCHEMAS[key];
      expect(zodSchema, `${key} に対応する Zod スキーマが表に無い`).toBeDefined();
      if (!zodSchema) continue;
      // 必須項目を 1 つずつ落とした本文は拒否されること
      for (const field of required) {
        // その項目だけを欠いた本文 (他の必須項目は形だけ埋める)
        const body = Object.fromEntries(
          required.filter((name) => name !== field).map((name) => [name, 'x']),
        );
        // 必須なので検証に失敗する
        expect(zodSchema.safeParse(body).success, `${key} の ${field} が必須でない`).toBe(false);
      }
    }
  });

  // 応答スキーマの「null を取りうるプロパティ」は、値が無いときも null として必ず応答に載る
  // (serializers.ts が全プロパティを組み立てる)。required から漏れると生成される型で省略可能になり、
  // 「未設定 (null)」と「そもそも欠落」を区別しない書き方が型検査を通ってしまう
  it('応答スキーマの null を取りうるプロパティは required に入っている', () => {
    // 応答から到達できるスキーマだけを対象にする。本文専用のスキーマ (作成の POST 本文と部分更新の PATCH 本文)
    // は対象外 — PATCH の「省略＝変更しない」は null 許容を required にできないため。
    // 逆に、本文用だったスキーマを応答にも使い始めたらその瞬間に対象へ入る
    const responseNames = collectResponseSchemaNames();
    // 1 つも集められなければ走査が壊れている (fail-closed)
    expect(responseNames.size).toBeGreaterThan(0);
    // 実際に見たプロパティの数 (走査が壊れて 0 件になったら落とす = fail-closed)
    let checked = 0;
    // components.schemas を走査する
    for (const [name, schema] of Object.entries(spec.components.schemas)) {
      // 応答に現れないスキーマは対象外
      if (!responseNames.has(name)) continue;
      // allOf / oneOf / anyOf の枝も見る (発行応答は allOf で secret を足す形なので、枝を見ないと取りこぼす)
      for (const branch of objectBranches(schema)) {
        // その枝が必須と宣言したプロパティ名
        const required = new Set(branch.required ?? []);
        for (const [property, definition] of Object.entries(branch.properties ?? {})) {
          // 型の宣言 (null を許すときだけ配列で書いている)
          const type = definition.type;
          // null を取らないプロパティは対象外
          if (!Array.isArray(type) || !type.includes('null')) continue;
          // 見た数を数える
          checked += 1;
          // required に入っていること
          expect(required.has(property), `${name}.${property} が required に無い`).toBe(true);
        }
      }
    }
    // 1 件も見ていなければ走査が壊れている
    expect(checked).toBeGreaterThan(0);
  });

  // 走査が components.responses を辿れていることを、導出とは独立な手掛かりで照合する
  // (同じ導出でガードを書くと、導出が狭まったときガードも一緒に狭まり「違反ゼロ＝緑」で無力化される)
  it('共通の応答定義から参照されるスキーマも required 検査の対象に入っている', () => {
    // 共通の応答定義 (401 / 403 / 404 …をまとめたもの)
    const declared = Object.values(spec.components.responses ?? {});
    // 1 つも無ければ手掛かりが消えている (fail-closed)
    expect(declared.length).toBeGreaterThan(0);
    // そこから直接参照されているスキーマ名
    const names = declared
      .flatMap((response) => componentRefsIn(response))
      .filter((ref) => ref.startsWith(`${COMPONENT_REF_PREFIX}schemas/`))
      .map(refName);
    // 1 つも無ければ同上
    expect(names.length).toBeGreaterThan(0);
    // 走査が集めた名前
    const responseNames = collectResponseSchemaNames();
    // 共通の応答から参照されるスキーマはすべて走査対象であること
    for (const name of names) {
      expect(responseNames.has(name), `${name} が応答スキーマの走査に入っていない`).toBe(true);
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
      RESOURCE_ID_MAX_LENGTH,
      MICRO_USD_MAX.toString().length,
    ]);
    // components.schemas のプロパティを走査する
    for (const [schemaName, schema] of Object.entries(spec.components.schemas)) {
      for (const [property, definition] of Object.entries(schema.properties ?? {})) {
        // maxLength を宣言していないプロパティは対象外
        const max = definition.maxLength;
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
      ApiKeyCreate: { name: SHORT_TEXT_MAX_LENGTH, agentId: RESOURCE_ID_MAX_LENGTH },
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
