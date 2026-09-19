// 契約テストを流してよい接続先の規則 (scripts/lib/contract-database.mjs)。
// 入口ガード (npm run test:contract) と契約テスト本体の両方がこの 1 か所を読むので、ここが壊れると
// 2 つのガードが同時に fail-open になり、開発 DB を指したまま TRUNCATE が走る。
// 規則を 1 か所へ集めた代わりに、その 1 か所は必ず検査する (写しを見張る他の検出網と同じ役割)
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_DATABASE_SUFFIX,
  CONTRACT_GUARD_MARKER,
  contractDatabaseProblem,
  runContractDatabaseGuard,
} from '../scripts/lib/contract-database.mjs';

// このファイルが読み込まれた時点 (= setupFiles が走った直後、どのテストより前) の印を控える。
// テスト本体でもガードを呼ぶので、その場で globalThis を見ると自分の呼び出しで印が付いてしまい、
// 検査が it の宣言順に依存する (順番を入れ替えるだけで結線の検査が恒久的に空回りする)
const GUARD_RAN_BEFORE_TESTS = (globalThis as Record<string, unknown>)[CONTRACT_GUARD_MARKER];

describe('契約テスト専用 DB の判定', () => {
  // CI のステップと CLAUDE.md §2 が使う DB 名 (agent_ops_contract) が通ること
  it('接尾辞が一致する接続先だけを許す', () => {
    // 専用 DB (問題なし = null)
    expect(contractDatabaseProblem('postgresql://u:p@h:5432/agent_ops_contract')).toBeNull();
    // クエリが付いていても DB 名は変わらない
    expect(
      contractDatabaseProblem('postgresql://u:p@h:5432/agent_ops_contract?schema=x'),
    ).toBeNull();
  });

  // 判定できない形も含めて拒否すること (不明なら拒否 = fail-closed)
  it('開発 DB・未設定・解釈できない形はすべて拒否する', () => {
    // 拒否されるべき接続先
    const rejected = [
      'postgresql://u:p@h:5432/agent_ops', // 開発 DB (seed 済みデータが消える)
      'postgresql://u:p@h:5432/agent_ops_contract_backup', // 接尾辞ではなく途中に含むだけ (endsWith → includes の変異を落とす)
      'postgresql://u:p@h:5432/', // DB 名が空
      'not a url', // URL として解釈できない
      '', // 空文字
      undefined, // 未設定
    ];
    // どれも理由の文言が返ること
    for (const url of rejected) {
      expect(contractDatabaseProblem(url), String(url)).not.toBeNull();
    }
  });

  // 接尾辞そのものを固定する (CI のステップと CLAUDE.md §2 に同じ名前が散文で出てくる)
  it('要求する接尾辞は _contract', () => {
    // 定数の値
    expect(CONTRACT_DATABASE_SUFFIX).toBe('_contract');
  });

  // 判定が正しくても、呼ばれていなければ何も守らない。結線の側も固定する
  // (設定ファイルの 1 行を消すと、契約テストを直接叩いたときに開発 DB が TRUNCATE される。
  //  痕跡はテスト件数にも出ないので、消えたことに気付く手立てがここ以外に無い)。
  // 設定の中身ではなく「実際に走った印」を見るので、結線の書き方 (setupFiles / 別の仕組み) を
  // 変えても検査ごと無力化されない
  it('契約 DB のガードが全テストファイルの前に走っている', () => {
    // 読み込み時点で控えた印 (判定を骨抜きにされていないことは下のテストが別に見る)
    expect(GUARD_RAN_BEFORE_TESTS).toBe(true);
  });

  // ガード本体の振る舞い。結線 (上のテスト) だけを見ていると、判定の中身を消しても印は残るので
  // 全件緑のまま通ってしまう。環境変数を注入して直接呼び、止めるべきときに止まることを固定する
  it('ガードは契約テストを流すときだけ、専用 DB 以外を止める', () => {
    // 合図が無ければ何もしない (ユニットテストだけを流す普段の実行)
    expect(() =>
      runContractDatabaseGuard({ DATABASE_URL: 'postgresql://u:p@h:5432/agent_ops' }),
    ).not.toThrow();
    // 合図があり専用 DB なら通す
    expect(() =>
      runContractDatabaseGuard({
        RUN_PRISMA_CONTRACT: '1',
        DATABASE_URL: 'postgresql://u:p@h:5432/agent_ops_contract',
      }),
    ).not.toThrow();
    // 合図があり開発 DB なら止める
    expect(() =>
      runContractDatabaseGuard({
        RUN_PRISMA_CONTRACT: '1',
        DATABASE_URL: 'postgresql://u:p@h:5432/agent_ops',
      }),
    ).toThrow(/専用 DB/);
    // 接続先が未設定でも止める (判定できないものは拒否 = fail-closed)
    expect(() => runContractDatabaseGuard({ RUN_PRISMA_CONTRACT: '1' })).toThrow(/専用 DB/);
  });

  // 上のテストは環境変数を注入して呼ぶので、既定引数 (実際の環境を読む結線) は素通りしてしまう。
  // 既定引数を空のオブジェクトへ変えると、setupFiles と契約テストの beforeAll はどちらも引数なしで
  // 呼ぶため 2 つの砦が同時に無効化されるのに全件緑になる (実測)。そこを 1 件で固定する
  it('引数を省くと実際の環境変数を読む', () => {
    // 環境変数の入れ物 (型の都合で緩めて扱う)
    const env = process.env as Record<string, string | undefined>;
    // 元の値を控える
    const savedFlag = env.RUN_PRISMA_CONTRACT;
    const savedUrl = env.DATABASE_URL;
    try {
      // 契約テストを流す合図と、専用でない接続先を置く
      env.RUN_PRISMA_CONTRACT = '1';
      env.DATABASE_URL = 'postgresql://u:p@h:5432/agent_ops';
      // 引数なしでもその環境を読んで止まること
      expect(() => runContractDatabaseGuard()).toThrow(/専用 DB/);
    } finally {
      // 元へ戻す (未設定だったものは消す。undefined を代入すると文字列 'undefined' になるため)
      if (savedFlag === undefined) delete env.RUN_PRISMA_CONTRACT;
      else env.RUN_PRISMA_CONTRACT = savedFlag;
      if (savedUrl === undefined) delete env.DATABASE_URL;
      else env.DATABASE_URL = savedUrl;
    }
  });
});
