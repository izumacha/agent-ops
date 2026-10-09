#!/usr/bin/env node
// 保守の定期実行を**一巡回し切る**まで `POST /maintenance/run` を叩く（ADR-0016）。
//
//   MAINTENANCE_BASE_URL=https://ops.example.com \
//   PLATFORM_ADMIN_TOKEN=... \
//   node scripts/maintenance-tick.mjs
//
// **スケジューラはこのリポジトリに持たない。** 配備先ごとに手段が違い（host の cron・systemd
// timer・GitHub Actions の `schedule`・クラウドのジョブ）、どれを選ぶかは運用の判断なので、
// 同梱するのは「1 回のティックで何をするか」だけにしてある。繋ぎ方は `docs/deploy.md`。
//
// **Vercel Cron からは直接呼べない** — あちらは GET しか発行せず、この経路は副作用がある
// （インシデントを作り、エージェントを止め、記録を消す）ので §9 により POST にしてある。
// Vercel で配備する場合も外部のスケジューラからこのスクリプトを回す。
//
// **終了コード**: 0 = 一巡を回し切った / 1 = 設定不足・HTTP エラー・**回数の上限に達して一巡を
// 回し切れなかった**・判定の失敗が残っている。
// 判定の失敗（`failed`）を 0 以外で終わらせるのは、**掃きが取りこぼしている状態を
// スケジューラの失敗として見えるようにする**ため（アプリ側は 200 を返して一巡を続ける）。

// 上限付きの `fetch`（写しを持たない。理由は共有モジュール側のコメント）
import { fetchWithTimeout } from './lib/fetch-with-timeout.mjs';

// 叩く先（アプリの入口。`/api/v1` までは付けない）
const baseUrl = process.env.MAINTENANCE_BASE_URL;
// プラットフォーム管理者トークン（この経路を叩ける唯一の資格情報）
const token = process.env.PLATFORM_ADMIN_TOKEN;
// 1 要求で判定するエージェント数（省略するとアプリ側の既定）
const agentBudget = process.env.MAINTENANCE_AGENT_BUDGET;

// 一巡で許す要求の回数の上限。**無制限に回さない** — アプリ側のカーソルが進まない不具合に
// 当たったとき、無限に叩き続けてしまう（しかも気付くのが遅れる）
const MAX_REQUESTS = 1_000;

// 設定が揃っていなければ測れない（fail-closed。「設定が無いから成功」に倒さない）
if (baseUrl === undefined || baseUrl === '') {
  console.error('[maintenance:tick]', 'MAINTENANCE_BASE_URL が未設定です');
  process.exit(1);
}
if (token === undefined || token === '') {
  console.error('[maintenance:tick]', 'PLATFORM_ADMIN_TOKEN が未設定です');
  process.exit(1);
}
// 予算の指定があれば**正の整数であること**を先に確かめる。
// `Number('abc')` は `NaN`、`Number('1e999')` は `Infinity` で、どちらも `JSON.stringify` で
// `null` になる。アプリ側の既定は `undefined` にしか効かないので明示的な `null` は 422 で、
// スクリプトは「HTTP 422 が返りました」としか言えない（**どの環境変数が悪いか伝わらない**）。
// 他の 2 つは変数名を名指しして fail-closed にしているので、ここも同じ扱いにそろえる
let budget;
if (agentBudget !== undefined && agentBudget !== '') {
  // 数値へ直す
  budget = Number(agentBudget);
  // 正の整数でなければ落とす（小数もアプリ側の `.int()` で 422 になる）
  if (!Number.isInteger(budget) || budget < 1) {
    console.error(
      '[maintenance:tick]',
      `MAINTENANCE_AGENT_BUDGET は 1 以上の整数で指定してください（受け取った値: ${agentBudget}）`,
    );
    process.exit(1);
  }
}

// 一巡の合計（ログに出す）
const total = {
  requests: 0,
  rateLimitHitsDeleted: 0,
  tenantsVisited: 0,
  agentsEvaluated: 0,
  rulesEvaluated: 0,
  fired: 0,
  failed: 0,
};
// **やることが残っていないと分かって抜けたか。** 回数で判定すると、ちょうど上限の回で
// 回し切ったときに「一巡が終わりません」と誤って非 0 終了する（off-by-one。予算 50 件なら
// 5 万エージェント規模で実際に到達する）。旗で持てば回数に依存しない
let completed = false;
// 続きの位置（最初は両方なし＝一巡の開始）
let tenantCursor;
let agentCursor;
// `passComplete` が真になるまで繰り返す
for (let request = 0; request < MAX_REQUESTS; request += 1) {
  // 本文を組み立てる（`null` のカーソルは送らない＝そこは先頭から）
  const body = {};
  if (tenantCursor !== undefined && tenantCursor !== null) body.tenantCursor = tenantCursor;
  if (agentCursor !== undefined && agentCursor !== null) body.agentCursor = agentCursor;
  if (budget !== undefined) body.agentBudget = budget;

  // 1 要求送る
  const response = await fetchWithTimeout(new URL('/api/v1/maintenance/run', baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  // 2xx 以外は続けられない（状態が分からないまま叩き続けない）
  if (!response.ok) {
    console.error('[maintenance:tick]', `HTTP ${response.status} が返りました`);
    process.exit(1);
  }
  // 進み具合を読む
  const result = await response.json();
  total.requests += 1;
  total.rateLimitHitsDeleted += result.rateLimitHitsDeleted;
  total.tenantsVisited += result.tenantsVisited;
  total.agentsEvaluated += result.agentsEvaluated;
  total.rulesEvaluated += result.rulesEvaluated;
  total.fired += result.fired;
  total.failed += result.failed;

  // **旗が真になるまで続きの位置を引き継ぐだけでよい。** 記録の回収が途中のときは
  // アプリ側がカーソルを 1 つも進めずに戻すので（`null` のまま）、ここは同じ呼び方を
  // もう一度することになる — 回収と判定で分岐を書き分ける必要が無い
  if (!result.passComplete) {
    tenantCursor = result.nextTenantCursor;
    agentCursor = result.nextAgentCursor;
    continue;
  }
  // やることが残っていない
  completed = true;
  break;
}

// 1 行 1 JSON（アプリのログと同じ形にして、収集側で同じように扱えるようにする）
process.stdout.write(`${JSON.stringify({ event: 'maintenance.tick', ...total })}\n`);

// 回し切る前にループを抜けたのは異常（カーソルが進んでいない可能性がある）
if (!completed) {
  console.error(
    '[maintenance:tick]',
    `要求が ${MAX_REQUESTS} 回に達しました（一巡が終わりません）`,
  );
  process.exit(1);
}
// 判定の取りこぼしがあればスケジューラの失敗として見えるようにする
if (total.failed > 0) {
  console.error('[maintenance:tick]', `判定できなかった件数: ${total.failed}`);
  process.exit(1);
}
