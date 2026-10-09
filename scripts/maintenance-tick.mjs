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

// 1 要求に許す時間。**共有モジュールの既定（デモの 1 件ずつの呼び出し向け）では短すぎる** —
// この受け口は 1 要求でテナントを歩き、最大 `MAINTENANCE_AGENT_BUDGET_MAX` 件のエージェントを
// 判定する一括処理なので、正常でも数十秒かかりうる。既定のまま使うと**健全な応答を待たずに
// 中断し**、しかも中断は例外なので下の報告を通さないと痕跡が残らない
const REQUEST_TIMEOUT_MS = 120_000;

// 2xx 以外のときに標準エラーへ出す本文の長さの上限（HTML のエラーページで埋もれないため）
const MAX_ERROR_BODY_CHARS = 500;

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
// 入口は **https** を要求する（ループバックだけ例外）。
//
// ここで送るのは配備でいちばん強い資格情報（プラットフォーム管理者トークン）を
// `Authorization: Bearer` に載せた要求なので、`http://` を設定すると**平文で流れる**。
// アプリ側の外向き通信は `src/lib/outbound-url.ts` が同じ理由で https を強制しているので、
// 送り手側もそろえる（ループバックを許すのは手元とテストのため。同じ集合を使う）
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
let entry;
try {
  // URL として読めることを先に確かめる（読めない値は下の `new URL(..., baseUrl)` で投げる）
  entry = new URL(baseUrl);
} catch {
  console.error('[maintenance:tick]', `MAINTENANCE_BASE_URL が URL として読めません: ${baseUrl}`);
  process.exit(1);
}
// ループバックか（`[::1]` は `URL` が角括弧を外すので両方の綴りで引く）
const entryIsLoopback =
  LOOPBACK_HOSTS.has(entry.hostname) || LOOPBACK_HOSTS.has(`[${entry.hostname}]`);
// https でなく、ループバックの http でもなければ落とす（fail-closed）
if (entry.protocol !== 'https:' && !(entry.protocol === 'http:' && entryIsLoopback)) {
  console.error(
    '[maintenance:tick]',
    `MAINTENANCE_BASE_URL は https を使ってください（管理者トークンを平文で送らないため）: ${baseUrl}`,
  );
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

// 応答から足し合わせる欄（**1 つでも数として読めなければ落とす**。下の検査が使う）
const COUNTED_FIELDS = [
  'rateLimitHitsDeleted',
  'tenantsVisited',
  'agentsEvaluated',
  'rulesEvaluated',
  'fired',
  'failed',
];

// 一巡の合計（ログに出す）。
//
// **`tenantVisits` は「テナントの件数」ではない。** 同じテナントにエージェントが残っている
// あいだアプリ側はテナントのカーソルを進めないので、そのテナントは続きの要求でもう一度
// 歩いた件数に数えられる（1 テナント × 500 エージェント・予算 50 なら 10 と出る）。
// 足し合わせて意味を持つのは「歩いた回数」なので、名前をそちらに合わせてある
const total = {
  requests: 0,
  rateLimitHitsDeleted: 0,
  tenantVisits: 0,
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

  // 1 要求送る。**例外をそのまま外へ出さない** — 素の `await` で落とすと Node が未処理の
  // reject として stack trace だけを出し、`[maintenance:tick]` の 1 行も下の合計の JSON も
  // 残らない（他の失敗経路はすべて理由を名指ししているので、ここだけ扱いを変えない）
  let response;
  try {
    response = await fetchWithTimeout(
      new URL('/api/v1/maintenance/run', baseUrl),
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      REQUEST_TIMEOUT_MS,
    );
  } catch (error) {
    // 理由を添えて落とす（中断・名前解決の失敗・接続断がここへ来る）
    console.error('[maintenance:tick]', '要求が失敗しました', error);
    process.exit(1);
  }
  // 2xx 以外は続けられない（状態が分からないまま叩き続けない）。
  // **本文も添える** — アプリ側の 422 は検証に失敗した項目を本文で名乗るので、ここで出すと
  // 「どの設定が悪いか」が運用者に伝わる（`MAINTENANCE_AGENT_BUDGET` を上限より大きくした等。
  // 上限そのものをこのスクリプトへ書き写すと、アプリ側を変えたとき写しだけが古くなる）。
  // 長い本文（HTML のエラーページ）で埋もれないよう頭だけにする
  if (!response.ok) {
    // 本文は読めないこともある（読めなければ空として扱う）
    const detail = await response.text().catch(() => '');
    console.error(
      '[maintenance:tick]',
      `HTTP ${response.status} が返りました`,
      detail.slice(0, MAX_ERROR_BODY_CHARS),
    );
    process.exit(1);
  }
  // 進み具合を読む。**ここも包む** — 200 なのに JSON でない応答（ログイン画面・中間装置の
  // HTML）だと `json()` が投げ、素の `await` では理由が `SyntaxError` の stack trace だけに
  // なって `[maintenance:tick]` の 1 行も合計の JSON も残らない（上の `fetch` と同じ事情）
  let result;
  try {
    result = await response.json();
  } catch (error) {
    console.error('[maintenance:tick]', '応答が JSON として読めません', error);
    process.exit(1);
  }
  // **数として読めない応答はここで落とす（fail-closed）。** 200 を返す中間装置やログイン画面が
  // 別の JSON を返すと `total.failed += undefined` で NaN になり、`NaN > 0` は偽なので
  // **取りこぼしの唯一の出口が黙って 0 終了する**（しかも合計の JSON には `null` と出るので
  // 「データなし」に見える）。予算の環境変数と同じく、叩く前後で数を確かめる扱いにそろえる
  for (const field of COUNTED_FIELDS) {
    if (!Number.isFinite(result[field])) {
      console.error(
        '[maintenance:tick]',
        `応答の ${field} が数として読めません（受け取った値: ${JSON.stringify(result[field])}）`,
      );
      process.exit(1);
    }
  }
  total.requests += 1;
  total.rateLimitHitsDeleted += result.rateLimitHitsDeleted;
  total.tenantVisits += result.tenantsVisited;
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
