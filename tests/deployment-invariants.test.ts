// 配備まわりの不変条件 (compose / Dockerfile / CI の配線)。
// ここに並ぶのは「アプリのコードをいくら見ても分からないが、外れると本番の守りが丸ごと消える」設定。
// 実測ではいずれも、外しても lint・typecheck・全ユニットテストが件数まで同じまま緑だった
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
// 契約テスト用 DB の判定 (入口ガード・setupFiles と同じ関数を使う。規則の写しを作らない)
import { contractDatabaseProblem } from '../scripts/lib/contract-database.mjs';

// リポジトリのルート
const ROOT = process.cwd();

// YAML を読んで解釈する (読めなければ前提が崩れているので落とす = fail-closed)
function readYaml(...segments: string[]): Record<string, unknown> {
  // ファイルを読む
  const text = readFileSync(join(ROOT, ...segments), 'utf8');
  // 解釈する
  const parsed = parse(text) as Record<string, unknown> | null;
  // オブジェクトとして読めること
  expect(parsed, `${segments.join('/')} を解釈できない`).toBeTypeOf('object');
  expect(parsed).not.toBeNull();
  return parsed as Record<string, unknown>;
}

// compose ファイルの名前の形 (docker compose が既定で読む綴りと、`-f` で足す派生ファイル)。
// **1 ファイルを名指ししない** — `docker-compose.override.yml` は何も書かなくても自動で重ねられるので、
// 名指しにすると「override 側で db を 0.0.0.0 に公開し直す」変更が丸ごと視界の外に落ちる
const COMPOSE_FILE_PATTERN = /^(?:docker-)?compose(?:\.[A-Za-z0-9_-]+)?\.ya?ml$/;

// compose のサービス定義の最小限の形 (走査に必要なキーだけ)
type ComposeService = {
  ports?: unknown[];
  environment?: unknown;
  network_mode?: unknown;
};

// ルート直下の compose ファイルを (ファイル名, サービス定義) の並びで集める
function collectComposeServices(): { file: string; name: string; service: ComposeService }[] {
  // 名前の形に一致するファイルを拾う
  const files = readdirSync(ROOT)
    .filter((name) => COMPOSE_FILE_PATTERN.test(name))
    .sort();
  // 1 つも無ければ走査が壊れている (fail-closed)
  expect(files.length, 'compose ファイルが 1 つも見つからない').toBeGreaterThan(0);
  // ファイルごとにサービスを平坦に並べる
  return files.flatMap((file) => {
    // services 節 (無いファイルもありうる)
    const services = (readYaml(file).services ?? {}) as Record<string, ComposeService | undefined>;
    // (ファイル, サービス名, 定義) の並びにする
    return Object.entries(services).map(([name, service]) => ({
      file,
      name,
      service: service ?? {},
    }));
  });
}

// LAN へ公開してよいサービスと、その理由 (**ここに増える差分は理由の妥当性をレビューで必ず確認する**)。
// 「db サービスの ports だけ」を見る形にすると、管理ツール (adminer 等) を 1 つ足して DB へ橋を架ける
// 形が視界に入らない (実測で全件緑のまま通った)。主語を「どのサービスも」にして、例外を表で持つ
const PUBLIC_SERVICE_REASONS: Record<string, string> = {
  app: 'アプリ本体。外から使うためのサービスで、前段に認証と RBAC がある',
};

// ループバックとみなすホスト側アドレス (ここに束ねたものだけが「外から届かない」)
const LOOPBACK_HOST = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|::1)$/;

/**
 * ports の 1 要素からホスト側アドレスを取り出す (指定が無ければ null = 全インタフェースに公開)。
 * **短い記法 (文字列) と長い記法 (オブジェクト) の両方を見る** — 長い記法へ書き換えるだけで
 * 文字列前提の検査が素通りする (実測で、オブジェクトを文字列として照合する形は例外で落ちていた)
 */
function hostAddressOf(mapping: unknown): string | null {
  // 長い記法: { target: 5432, published: 5432, host_ip: 127.0.0.1 }
  if (mapping !== null && typeof mapping === 'object') {
    // host_ip が無ければ全インタフェース
    const hostIp = (mapping as { host_ip?: unknown }).host_ip;
    return typeof hostIp === 'string' ? hostIp : null;
  }
  // 短い記法: '127.0.0.1:5432:5432' / '5432:5432' / '5432'
  const text = String(mapping);
  // IPv6 は角括弧で囲む ('[::1]:5432:5432')
  const bracketed = /^\[([^\]]+)\]:/.exec(text);
  if (bracketed) return bracketed[1];
  // コロン区切りが 3 つ以上あるときだけ先頭がホスト側アドレス
  const parts = text.split(':');
  return parts.length >= 3 ? parts[0] : null;
}

/**
 * environment を (キー, 値) の並びに正規化する。
 * **マップ形式と配列形式の両方を見る** — compose はどちらも受け付けるので、配列形式
 * (`- PLATFORM_ADMIN_TOKEN=secret`) へ書き換えるだけで、マップ前提の走査は
 * 「キーが '0'、値が 'PLATFORM_ADMIN_TOKEN=secret'」になり秘密の検査が丸ごと消える (実測)
 */
function environmentEntries(environment: unknown): [string, string][] {
  // 配列形式: ['KEY=value', 'KEY'] (後者はホストの同名変数をそのまま渡す = 既定値なし)
  if (Array.isArray(environment)) {
    return environment.flatMap((item): [string, string][] => {
      // 文字列以外は書けないので無視する
      if (typeof item !== 'string') return [];
      // 最初の '=' で分ける
      const separator = item.indexOf('=');
      // '=' が無ければ既定値なし (空文字と同じ扱い)
      return separator < 0 ? [[item, '']] : [[item.slice(0, separator), item.slice(separator + 1)]];
    });
  }
  // マップ形式: { KEY: value }
  if (typeof environment === 'object' && environment !== null) {
    // 値は数値や null でも書けるので文字列へ揃える (null は「既定値なし」)
    return Object.entries(environment).map(([key, value]): [string, string] => [
      key,
      value === null || value === undefined ? '' : String(value),
    ]);
  }
  // environment を書いていない
  return [];
}

// compose の変数展開の形 (`${VAR}` / `${VAR:-既定値}` / `${VAR-既定値}` / `${VAR:?メッセージ}` / `${VAR?メッセージ}`)
const INTERPOLATION_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])([\s\S]*))?\}$/;

/**
 * 秘密の環境変数の値が「未設定なら何も動かない」形になっているか (問題があれば理由を返す)。
 *
 * 許すのは 3 つ: 空文字 / `${VAR}` 系で既定値が空 / `${VAR:?メッセージ}` 系 (未設定なら起動を失敗させる)。
 * **`:?` を弾かない** — 未設定を明示的に失敗させる書き方は `${VAR:-}` より安全なので、
 * 検出網がそれを拒むと「安全側へ直すと赤くなる」ことになり、いずれ検査ごと緩められる
 */
function secretDefaultProblem(value: string): string | null {
  // 空文字は「値を渡さない」ので問題なし
  if (value === '') return null;
  // 変数展開の形か
  const match = INTERPOLATION_PATTERN.exec(value);
  // 展開でなければ、リポジトリに書かれたそのままの資格情報
  if (!match) return `リテラルの既定値 ${JSON.stringify(value)} が書かれている`;
  // 演算子 (無ければ単なる `${VAR}`)
  const [, , operator, fallback] = match;
  // `${VAR}` は既定値を持たない
  if (operator === undefined) return null;
  // `:?` / `?` は未設定なら起動を失敗させる (fail-closed なので許す)
  if (operator.endsWith('?')) return null;
  // `:-` / `-` は既定値。空でなければその値で誰でも動いてしまう
  return fallback === '' ? null : `既定値 ${JSON.stringify(fallback)} が書かれている`;
}

// 既定値を許す秘密と、その理由 (**ここに増える差分は理由の妥当性をレビューで必ず確認する**)。
// 表に無い秘密はすべて「未設定で動く」ことを求める
const SECRET_ENV_REASONS: Record<string, string> = {
  'db.POSTGRES_PASSWORD':
    'ローカル開発用 DB コンテナの初期化値。db はループバックにしか公開せず、同じ compose 内の ' +
    'DATABASE_URL とセットでしか使わない (本番は compose ではなくマネージド DB を使う)。' +
    'アプリの認証に使う資格情報ではないので、未設定を要求すると quickstart が動かなくなる分の利得が無い',
};

// 秘密を入れる環境変数の名前 (この形の変数に既定値を与えない)
const SECRET_ENV_PATTERN = /(_TOKEN|_PASSWORD|_SECRET)$/;

describe('compose ファイル', () => {
  // ルート直下の全 compose ファイルのサービス定義
  const entries = collectComposeServices();

  it('LAN へ公開してよいのは理由を書いたサービスだけ (それ以外はループバックに限定する)', () => {
    // サービスを 1 つも読めなければ走査が壊れている (fail-closed)
    expect(entries.length).toBeGreaterThan(0);
    for (const { file, name, service } of entries) {
      // ホストのネットワークをそのまま使う形は publish の指定を素通りするので禁止する
      expect(
        service.network_mode,
        `${file} の ${name} が network_mode でホストのネットワークを使っている`,
      ).not.toBe('host');
      // 理由を書いたサービスは公開してよい
      if (name in PUBLIC_SERVICE_REASONS) continue;
      // 公開しているポートの一覧 (省略時は公開なし)
      for (const mapping of service.ports ?? []) {
        // ホスト側アドレス (短い記法・長い記法のどちらでも取り出す)
        const host = hostAddressOf(mapping);
        // 指定が無い ('5432:5432') と 0.0.0.0 はどちらも全インタフェースへの公開。
        // DB は Bearer 認証の資格情報ストアなので、1 行 INSERT で全テナントの admin になれる
        expect(
          host !== null && LOOPBACK_HOST.test(host),
          `${file} の ${name} の公開ポート ${JSON.stringify(mapping)} がループバックに限定されていない`,
        ).toBe(true);
      }
    }
  });

  it('秘密の環境変数に既定値を与えない (未設定であることが fail-closed の前提)', () => {
    for (const { file, name, service } of entries) {
      // 環境変数の一覧 (マップ形式・配列形式のどちらでも同じ並びに正規化する)
      for (const [key, value] of environmentEntries(service.environment)) {
        // 秘密でなければ見ない
        if (!SECRET_ENV_PATTERN.test(key)) continue;
        // 理由を書いた例外は許す
        if (`${name}.${key}` in SECRET_ENV_REASONS) continue;
        // 空でない既定値を書くと、`docker compose up` したすべての配備が「リポジトリに書かれた公開の
        // 資格情報」で動く。プラットフォーム管理者トークンは「未設定なら誰もなれない」が唯一の
        // fail-closed なので、既定値はそれを丸ごと無効化する
        expect(secretDefaultProblem(value), `${file} の ${name}.${key}`).toBeNull();
      }
    }
  });
});

describe('.env.example', () => {
  // 雛形の中身
  const example = readFileSync(join(ROOT, '.env.example'), 'utf8');

  it('プラットフォーム管理者トークンは空で配る (雛形から動く資格情報を配らない)', () => {
    // 値が空であること (雛形に実際に使える値を書くと、コピーした全員が同じ秘密を共有する)。
    // 引用符の有無・種類は本質でないのでどれも許す (安全な書き方を赤くしない)
    expect(example).toMatch(/^PLATFORM_ADMIN_TOKEN=(?:""|'')?\s*$/m);
  });
});

describe('.dockerignore', () => {
  // 除外設定の中身
  const ignore = readFileSync(join(ROOT, '.dockerignore'), 'utf8');

  it('.env を イメージへ持ち込まない (雛形だけは例外)', () => {
    // 開発者の .env を builder ステージの COPY . . が取り込むと、ビルドキャッシュに秘密が残る
    expect(ignore).toMatch(/^\.env\*$/m);
    expect(ignore).toMatch(/^!\.env\.example$/m);
  });
});

describe('Dockerfile', () => {
  // Dockerfile の本文
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');

  it('実行ステージは非 root で動かす (USER 指定がある)', () => {
    // runner ステージ以降の行だけを見る
    const runnerIndex = dockerfile.indexOf('FROM base AS runner');
    expect(runnerIndex, 'runner ステージが見つからない').toBeGreaterThan(-1);
    const runner = dockerfile.slice(runnerIndex);
    // USER 指定があり、root でないこと。外すとコンテナ内の任意コード実行がそのまま root になる。
    // **最後の USER を見る** — Docker が採用するのは最後の指定なので、最初の 1 件だけを見ると
    // 「migrate のために root へ戻す」ともっともらしい理由を書いて後ろに USER root を足す変更が
    // 素通りする (実測で全件緑のまま通った)
    const users = [...runner.matchAll(/^USER\s+(\S+)/gm)];
    expect(users.length, 'runner ステージに USER 指定が無い').toBeGreaterThan(0);
    expect(users[users.length - 1][1]).not.toBe('root');
  });
});

describe('CI ワークフロー', () => {
  // ci.yml のジョブ定義
  const jobs = readYaml('.github', 'workflows', 'ci.yml').jobs as Record<
    string,
    { steps?: { run?: string; env?: Record<string, string> }[] } | undefined
  >;
  // 全ジョブのステップを 1 本に並べる
  const steps = Object.values(jobs).flatMap((job) => job?.steps ?? []);

  it('実装済みの最新 Step のゲートを実行している', () => {
    // ステップを 1 つも読めなければ走査が壊れている (fail-closed)
    expect(steps.length).toBeGreaterThan(0);
    // scripts/ にある gate-stepN.mjs のうち最大の N が「実装済みの最新 Step」。
    // **CI 側の綴りから導かない** — ci.yml だけを見る検査は ci.yml を変えた瞬間に一緒に緩むので、
    // 手掛かりを「リポジトリにどのゲートが実装されているか」へ移す
    const numbers = readdirSync(join(ROOT, 'scripts'))
      .map((name) => /^gate-step(\d+)\.mjs$/.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]));
    // ゲートが 1 つも無ければ手掛かりが消えている (fail-closed)
    expect(numbers.length, 'scripts/ に gate-stepN.mjs が無い').toBeGreaterThan(0);
    // 最新のゲート名
    const latest = `gate:step${Math.max(...numbers)}`;
    // **lint / format / typecheck / テスト件数 / RBAC 3×3 / npm audit を CI で回しているのはこの 1 コマンドだけ**。
    // 実測では、ci.yml から gate ジョブを丸ごと消しても他のジョブは緑のままで、何も鳴らなかった
    expect(
      steps.some((step) => step.run?.includes(latest)),
      `ci.yml が ${latest} を実行していない`,
    ).toBe(true);
  });

  it('契約テストを専用 DB で実際に実行している', () => {
    // ステップを 1 つも読めなければ走査が壊れている (fail-closed)
    expect(steps.length).toBeGreaterThan(0);
    // 契約テストを流すステップ (コマンドの綴りで探す)
    const contractSteps = steps.filter((step) => step.run?.includes('test:contract'));
    // **本番アダプタのテナント境界を守る唯一の網がこれ**。実測では、prisma アダプタの where から
    // tenantId を落としても全 264 件が緑のままで、赤くなるのは契約テストだけだった。
    // そのうえ、このステップを ci.yml から消しても何も鳴らなかった (契約テストは skipIf で飛ぶだけ)
    expect(contractSteps.length, 'ci.yml が契約テストを実行していない').toBeGreaterThan(0);
    for (const step of contractSteps) {
      // 明示フラグが立っていること (無いと describe.skipIf で丸ごと飛ぶ)
      expect(step.env?.RUN_PRISMA_CONTRACT, '契約テストの実行フラグが立っていない').toBe('1');
      // 接続先が契約テスト専用 DB であること (判定は入口ガードと同じ関数を使う)
      expect(
        contractDatabaseProblem(step.env?.DATABASE_URL ?? ''),
        'CI の接続先が専用 DB でない',
      ).toBeNull();
    }
  });
});
