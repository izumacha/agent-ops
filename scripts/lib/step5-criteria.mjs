// Step5 の受け入れ基準のしきい値と、照合に使う手がかり (docs/roadmap.md の Step5 行が正本)。
// E2E (e2e/screens.spec.ts)・Lighthouse の計測 (scripts/measure-lighthouse.ts)・ゲート
// (scripts/gate-step5.mjs)・ロードマップとの突き合わせ (tests/docs-gate.test.ts)・
// スクリーンショットの撮影 (scripts/capture-screenshots.ts) がここを読む。
// 値を 5 か所に書き写すと必ずどれかが古くなる。

// Lighthouse の合格点 (0〜100)。受け入れ基準「Performance / Accessibility ≧ 90」そのもの。
// **100 点満点で持つ**のは、ロードマップの散文も Lighthouse の画面表示も 100 点満点だから
// (lighthouse の API が返す値は 0〜1 なので、計測スクリプトが 100 倍して出す)
export const LIGHTHOUSE_MIN_SCORE = 90;

// 点数を見るカテゴリ。**両方を見る** — 片方だけだと、もう一方が 90 を割っても気付けない
export const LIGHTHOUSE_CATEGORIES = ['performance', 'accessibility'];

// 1 画面あたりの計測回数（判定には**中央値**を使う）。**奇数にする** — 偶数だと中央値が
// 2 つの平均になり、外れ値が半分だけ混ざる。1 回では判定に使えない（同じコミットで
// Performance が 81〜98 の幅で揺れた実測があり、Lighthouse 自身も複数回の中央値を勧めている）
export const LIGHTHOUSE_RUNS = 3;

/**
 * 主要 5 画面。**これが「どの画面を見るか」の唯一の宣言**で、E2E のテスト名・Lighthouse の
 * 計測対象・スクリーンショットの撮影対象がすべてここから導かれる。別々に並べると
 * 「E2E はあるのに Lighthouse では測っていない画面」が静かに生まれる。
 *
 * - `title` は E2E のテスト名の後半 (`画面: <title>`) とスクリーンショットの説明に使う
 * - `path` は URL。`{agentId}` は実行時に仕込んだエージェントの id へ置き換える
 * - `auth` が true の画面はセッション Cookie が必要 (Lighthouse はヘッダで渡す)
 * - `file` はスクリーンショットのファイル名 (CLAUDE.md §3 の「見せ方」が宣言している 5 枚)
 */
export const STEP5_SCREENS = [
  { key: 'login', title: 'ログイン', path: '/login', auth: false, file: 'login.png' },
  {
    key: 'dashboard',
    title: 'ダッシュボード',
    path: '/dashboard',
    auth: true,
    file: 'dashboard.png',
  },
  {
    key: 'agents',
    title: 'エージェント一覧',
    path: '/agents',
    auth: true,
    file: 'agents-list.png',
  },
  {
    key: 'agent-detail',
    title: 'エージェント詳細',
    path: '/agents/{agentId}',
    auth: true,
    file: 'agent-detail.png',
  },
  {
    key: 'incidents',
    title: 'インシデント一覧',
    path: '/incidents',
    auth: true,
    file: 'incidents.png',
  },
];

// E2E のテスト名の接頭辞。`e2e/screens.spec.ts` が `画面: <title>` という名前で 1 画面 1 本書き、
// ゲートは **5 画面すべてぶんが pass しているか**をこの接頭辞で照合する
// (料金表からモデル名を導くのと同じ形。画面を足してテストを書き忘れたら落ちる)
export const SCREEN_TEST_PREFIX = '画面: ';

// 突合テストの名前 (完全一致ではなく、この文字列を含む pass したテストを探す)。
// 受け入れ基準「表示データと DB 集計の突合テスト一致 100%」そのもので、
// **画面・CSV・テストが同じ集計関数を通る**ことをそのテストが固定する
export const RECONCILE_TEST_NAME = '突合: 表示データと DB 集計が一致する';

// `path` の中のエージェント id の差し込み口 (画面の一覧と計測側で綴りを共有する)
export const AGENT_ID_PLACEHOLDER = '{agentId}';

/**
 * 画面のパスを、仕込んだデータの id で埋めて返す。
 * @param {{ path: string }} screen 画面の宣言
 * @param {{ agentId: string }} fixture 仕込んだデータ
 * @returns {string} 差し込み後のパス
 */
export function screenPath(screen, fixture) {
  // 差し込み口をエージェントの id へ置き換える (無ければそのまま返る)
  return screen.path.replaceAll(AGENT_ID_PLACEHOLDER, fixture.agentId);
}
