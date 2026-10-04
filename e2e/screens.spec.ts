// 主要 5 画面の E2E（Step5 の受け入れ基準 2）。
//
// **テスト名 `画面: <画面名>` は `scripts/lib/step5-criteria.mjs` の画面一覧から導く** —
// ゲートは「5 画面すべてに pass したテストがあるか」をその一覧から照合するので、画面を足して
// テストを書き忘れたら落ちる（手書きの一覧にしない。料金表からモデル名を導くのと同じ形）。
//
// **直列で流す**（`playwright.config.ts` の `workers: 1`）— 停止 → 復帰 → 解決と状態を書き換える。
import { expect, test, type BrowserContext } from '@playwright/test';
import { SCREEN_TEST_PREFIX, STEP5_SCREENS, screenPath } from '../scripts/lib/step5-criteria.mjs';
import { readE2eFixture } from './lib/fixture';
import { SESSION_COOKIE_NAME } from '../src/lib/session';
import { AGENT_STATUS_LABELS, INCIDENT_STATUS_LABELS, UI_TEXT } from '../src/lib/constants';
import { AgentStatus, IncidentStatus } from '../src/domain/types';

// 仕込んだ内容（globalSetup が書き出したもの）
const fixture = readE2eFixture();

// 画面一覧から「その画面のテスト名」を引く（名前の綴りを書き写さない）
function titleOf(key: string): string {
  // 一覧から該当の画面を探す
  const screen = STEP5_SCREENS.find((entry) => entry.key === key);
  // 無ければ一覧とテストが食い違っている（fail-closed）
  if (screen === undefined) throw new Error(`画面一覧に ${key} がありません`);
  // ゲートが照合する形（接頭辞 + 画面名）
  return `${SCREEN_TEST_PREFIX}${screen.title}`;
}

// 画面一覧から URL を組み立てる（エージェント詳細は仕込んだ id を差し込む）
function urlOf(key: string): string {
  // 一覧から該当の画面を探す
  const screen = STEP5_SCREENS.find((entry) => entry.key === key);
  // 無ければ一覧とテストが食い違っている（fail-closed）
  if (screen === undefined) throw new Error(`画面一覧に ${key} がありません`);
  // 差し込み後のパスを絶対 URL にする
  return `${fixture.baseUrl}${screenPath(screen, fixture)}`;
}

/**
 * セッション Cookie を直接張る（ログイン画面を経由しない）。
 *
 * **ログインの経路はログイン画面のテストが通す。** 残りの画面でも毎回フォームを操作すると、
 * 落ちたときに「その画面が壊れたのか、ログインが壊れたのか」が切り分けられない。
 */
async function loginByCookie(context: BrowserContext): Promise<void> {
  // 本番と同じ名前の Cookie に、仕込んだトークンそのものを入れる（ADR-0011 の設計）
  await context.addCookies([
    { name: SESSION_COOKIE_NAME, value: fixture.token, url: fixture.baseUrl },
  ]);
}

test.describe('主要 5 画面', () => {
  // 状態を書き換えるので直列で流す
  test.describe.configure({ mode: 'serial' });

  test(titleOf('login'), async ({ page }) => {
    // ログイン画面を開く
    await page.goto(urlOf('login'));
    // 見出しが出ている
    await expect(page.getByRole('heading', { name: UI_TEXT.loginTitle })).toBeVisible();
    // トークンを貼り付けて送信する（本番と同じ操作）
    await page.getByLabel(UI_TEXT.loginTokenLabel).fill(fixture.token);
    await page.getByRole('button', { name: UI_TEXT.loginSubmit }).click();
    // ダッシュボードへ遷移している（認証が通った証拠）
    await expect(page.getByRole('heading', { name: UI_TEXT.dashboardTitle })).toBeVisible();
  });

  test(titleOf('dashboard'), async ({ page, context }) => {
    // Cookie でログイン状態にしてから開く
    await loginByCookie(context);
    await page.goto(urlOf('dashboard'));
    // 5 枚のカードが出ている（コスト・中継回数・稼働率・品質・未解決インシデント）。
    // **カードの枠に絞って探す** — 「中継回数」は日次表の列見出しにも出るので、画面全体から
    // 探すと 2 件に当たって落ちる（文言は 1 か所に集めてあるので同じ語が両方に出る）
    const cards = page.locator('.cards');
    for (const label of [
      UI_TEXT.cardCost,
      UI_TEXT.cardRequests,
      UI_TEXT.cardUptime,
      UI_TEXT.cardQuality,
      UI_TEXT.cardOpenIncidents,
    ]) {
      await expect(cards.getByText(label, { exact: true })).toBeVisible();
    }
    // 日次の内訳が表として出ている（仕込んだ利用イベントがある日の行）
    await expect(page.getByRole('heading', { name: UI_TEXT.dailyTableTitle })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();
    // **稼働率が「測れていない」ではない** — 仕込んだ利用イベントがあるので百分率が出る。
    // 具体的な数値はここで固定しない（突合テストが DB の集計と突き合わせている。写しを作らない）
    await expect(cards.getByText(/^\d+(\.\d+)?%$/)).toBeVisible();
    // CSV のダウンロードが同じ期間で引けること（画面と同じ集計関数を通る）
    const link = page.getByRole('link', { name: UI_TEXT.dailyReportLink });
    await expect(link).toBeVisible();
    // リンク先を実際に取得して、CSV として返ることを確かめる
    const href = await link.getAttribute('href');
    expect(href).not.toBeNull();
    const csv = await page.request.get(`${fixture.baseUrl}${href ?? ''}`);
    expect(csv.ok()).toBe(true);
    // 添付として返る（ブラウザがダウンロードする形）
    expect(csv.headers()['content-type']).toContain('text/csv');
    expect(csv.headers()['content-disposition']).toContain('attachment');
    // **共有キャッシュに載せない**（テナントごとに中身が違う）
    expect(csv.headers()['cache-control']).toContain('no-store');
    // 先頭に BOM があり（Excel が UTF-8 と判断できる）、見出しが日本語で入っている
    const body = await csv.text();
    expect(body.startsWith('﻿')).toBe(true);
    expect(body).toContain(UI_TEXT.columnUptime);
  });

  test(titleOf('agents'), async ({ page, context }) => {
    // Cookie でログイン状態にしてから開く
    await loginByCookie(context);
    await page.goto(urlOf('agents'));
    // 見出しと、仕込んだエージェントの行が出ている
    await expect(page.getByRole('heading', { name: UI_TEXT.agentsTitle })).toBeVisible();
    await expect(page.getByRole('link', { name: fixture.agentName })).toBeVisible();
    // 状態は「稼働中」（日本語ラベルで出す）
    await expect(page.getByText(AGENT_STATUS_LABELS[AgentStatus.active])).toBeVisible();
  });

  test(titleOf('agent-detail'), async ({ page, context }) => {
    // Cookie でログイン状態にしてから開く
    await loginByCookie(context);
    await page.goto(urlOf('agent-detail'));
    // 見出しはエージェント名
    await expect(page.getByRole('heading', { name: fixture.agentName })).toBeVisible();
    // **停止できる**（admin なのでボタンが出る）
    await page.getByRole('button', { name: UI_TEXT.agentStop }).click();
    // 結果が文字で出る
    await expect(page.getByText(UI_TEXT.agentStopped)).toBeVisible();
    // 画面を開き直すと状態が「停止中」になっている（DB に書かれた証拠）
    await page.reload();
    await expect(page.getByText(AGENT_STATUS_LABELS[AgentStatus.stopped])).toBeVisible();
    // **復帰もできる**（止めたままにしない）
    await page.getByRole('button', { name: UI_TEXT.agentResume }).click();
    await expect(page.getByText(UI_TEXT.agentResumed)).toBeVisible();
    // 開き直すと「稼働中」へ戻っている
    await page.reload();
    await expect(page.getByText(AGENT_STATUS_LABELS[AgentStatus.active])).toBeVisible();
  });

  test(titleOf('incidents'), async ({ page, context }) => {
    // Cookie でログイン状態にしてから開く
    await loginByCookie(context);
    await page.goto(urlOf('incidents'));
    // 見出しと、仕込んだ未解決インシデントの行が出ている
    await expect(page.getByRole('heading', { name: UI_TEXT.incidentsTitle })).toBeVisible();
    await expect(page.getByText(INCIDENT_STATUS_LABELS[IncidentStatus.open])).toBeVisible();
    // **解決できる**（admin 限定の操作）
    await page.getByRole('button', { name: UI_TEXT.incidentResolve }).click();
    await expect(page.getByText(UI_TEXT.incidentResolved)).toBeVisible();
    // 既定（未解決のみ）では一覧から消える
    await page.goto(urlOf('incidents'));
    await expect(page.getByText(UI_TEXT.incidentsEmptyOpen)).toBeVisible();
    // 「すべて」に切り替えると解決済みとして残っている
    await page.getByRole('link', { name: UI_TEXT.incidentsViewAll }).click();
    await expect(page.getByText(INCIDENT_STATUS_LABELS[IncidentStatus.resolved])).toBeVisible();
  });
});
