// 配備まわりの不変条件 (compose / Dockerfile / CI の配線)。
// ここに並ぶのは「アプリのコードをいくら見ても分からないが、外れると本番の守りが丸ごと消える」設定。
// 実測ではいずれも、外しても lint・typecheck・全ユニットテストが件数まで同じまま緑だった
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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

// LAN へ公開してよいサービスと、その理由 (**ここに増える差分は理由の妥当性をレビューで必ず確認する**)。
// 「db サービスの ports だけ」を見る形にすると、管理ツール (adminer 等) を 1 つ足して DB へ橋を架ける
// 形が視界に入らない (実測で全件緑のまま通った)。主語を「どのサービスも」にして、例外を表で持つ
const PUBLIC_SERVICE_REASONS: Record<string, string> = {
  app: 'アプリ本体。外から使うためのサービスで、前段に認証と RBAC がある',
};

// 秘密を入れる環境変数の名前 (この形の変数に既定値を与えない)
const SECRET_ENV_PATTERN = /(_TOKEN|_PASSWORD|_SECRET)$/;

// 既定値を許す秘密と、その理由 (**ここに増える差分は理由の妥当性をレビューで必ず確認する**)。
// 表に無い秘密はすべて「未設定で動く」ことを求める
const SECRET_ENV_REASONS: Record<string, string> = {
  'db.POSTGRES_PASSWORD':
    'ローカル開発用 DB コンテナの初期化値。db はループバックにしか公開せず、同じ compose 内の ' +
    'DATABASE_URL とセットでしか使わない (本番は compose ではなくマネージド DB を使う)。' +
    'アプリの認証に使う資格情報ではないので、未設定を要求すると quickstart が動かなくなる分の利得が無い',
};

describe('docker-compose.yml', () => {
  // compose のサービス定義
  const services = readYaml('docker-compose.yml').services as Record<
    string,
    { ports?: string[]; environment?: Record<string, string>; network_mode?: string } | undefined
  >;

  it('LAN へ公開してよいのは理由を書いたサービスだけ (それ以外はループバックに限定する)', () => {
    // サービスを 1 つも読めなければ走査が壊れている (fail-closed)
    expect(Object.keys(services).length).toBeGreaterThan(0);
    for (const [name, service] of Object.entries(services)) {
      // ホストのネットワークをそのまま使う形は publish の指定を素通りするので禁止する
      expect(
        service?.network_mode,
        `${name} が network_mode でホストのネットワークを使っている`,
      ).not.toBe('host');
      // 理由を書いたサービスは公開してよい
      if (name in PUBLIC_SERVICE_REASONS) continue;
      // 公開しているポートの一覧 (省略時は公開なし)
      for (const mapping of service?.ports ?? []) {
        // ホスト側のアドレスが 127.0.0.1 (または localhost) で始まること。
        // '5432:5432' のように書くと 0.0.0.0 に公開され、既定資格情報のまま誰でも接続できる。
        // DB は Bearer 認証の資格情報ストアなので、1 行 INSERT で全テナントの admin になれる
        expect(mapping, `${name} の公開ポート ${mapping} がループバックに限定されていない`).toMatch(
          /^(?:127\.0\.0\.1|localhost):/,
        );
      }
    }
  });

  it('秘密の環境変数に既定値を与えない (未設定であることが fail-closed の前提)', () => {
    for (const [name, service] of Object.entries(services)) {
      // 環境変数の一覧 (マップ形式で書いている前提。配列形式にしたらこの検査も直す)
      for (const [key, value] of Object.entries(service?.environment ?? {})) {
        // 秘密でなければ見ない
        if (!SECRET_ENV_PATTERN.test(key)) continue;
        // 理由を書いた例外は許す
        if (`${name}.${key}` in SECRET_ENV_REASONS) continue;
        // `${VAR:-}` の形 (既定値が空) だけを許す。空でない既定値を書くと、`docker compose up` した
        // すべての配備が「リポジトリに書かれた公開の資格情報」で動く。プラットフォーム管理者トークンは
        // 「未設定なら誰もなれない」が唯一の fail-closed なので、既定値はそれを丸ごと無効化する
        expect(String(value), `${name}.${key} に空でない既定値がある`).toMatch(
          /^\$\{[A-Z0-9_]+:?-?\}$|^\$\{[A-Z0-9_]+\}$/,
        );
      }
    }
  });
});

describe('.env.example', () => {
  // 雛形の中身
  const example = readFileSync(join(ROOT, '.env.example'), 'utf8');

  it('プラットフォーム管理者トークンは空で配る (雛形から動く資格情報を配らない)', () => {
    // 値が空であること (雛形に実際に使える値を書くと、コピーした全員が同じ秘密を共有する)
    expect(example).toMatch(/^PLATFORM_ADMIN_TOKEN=""?\s*$/m);
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
