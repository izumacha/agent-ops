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

describe('docker-compose.yml', () => {
  // compose のサービス定義
  const services = readYaml('docker-compose.yml').services as Record<
    string,
    { ports?: string[] } | undefined
  >;

  it('DB はループバックにしか公開しない (資格情報ストアを LAN へ晒さない)', () => {
    // db サービスが居ること (名前を変えたらこの検査も一緒に直す)
    const db = services.db;
    expect(db, 'db サービスが見つからない').toBeTypeOf('object');
    // 公開しているポートの一覧 (省略時は公開なし)
    const ports = db?.ports ?? [];
    for (const mapping of ports) {
      // ホスト側のアドレスが 127.0.0.1 (または localhost) で始まること。
      // '5432:5432' のように書くと 0.0.0.0 に公開され、既定資格情報のまま誰でも接続できる。
      // この DB は Bearer 認証の資格情報ストアなので、1 行 INSERT で全テナントの admin になれる
      expect(mapping, `db の公開ポート ${mapping} がループバックに限定されていない`).toMatch(
        /^(?:127\.0\.0\.1|localhost):/,
      );
    }
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
    // USER 指定があり、root でないこと。外すとコンテナ内の任意コード実行がそのまま root になる
    const user = runner.match(/^USER\s+(\S+)/m);
    expect(user, 'runner ステージに USER 指定が無い').not.toBeNull();
    expect(user?.[1]).not.toBe('root');
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
