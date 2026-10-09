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

// 同期の書き出し（理由は `writeSummary`）
import { writeSync } from 'node:fs';
// 上限付きの `fetch`（写しを持たない。理由は共有モジュール側のコメント）
import { fetchWithTimeout } from './lib/fetch-with-timeout.mjs';

// 1 要求に許す時間。**共有モジュールの既定（デモの 1 件ずつの呼び出し向け）では短すぎる** —
// この受け口は 1 要求でテナントを歩き、最大 `MAINTENANCE_AGENT_BUDGET_MAX` 件のエージェントを
// 判定する一括処理なので、正常でも数十秒かかりうる。既定のまま使うと**健全な応答を待たずに
// 中断し**、しかも中断は例外なので下の報告を通さないと痕跡が残らない。
//
// **経路側が自分に許している時間（`maxDuration` = 300 秒）より長くする。** 短いと、サーバーが
// 完了してよいと宣言している要求をこちら側が打ち切ることになり、**応答＝続きのカーソルを
// 受け取れないまま**次のティックがまた先頭から始める（毎回同じ要求で落ちる）。
// 値を写しているのは、このスクリプトが依存ゼロの素の node で動く前提で TypeScript の定数を
// import できないため — 経路側の `maxDuration` を動かしたらここも見ること
const REQUEST_TIMEOUT_MS = 330_000;

// 2xx 以外のときに標準エラーへ出す本文の長さの上限（HTML のエラーページで埋もれないため）
const MAX_ERROR_BODY_CHARS = 500;

// **前後の空白を落として読む。** 秘密の受け渡し（`export $(cat .env | xargs)`・シークレット
// ストアの改行つきの値）で末尾に `\n` が残るのはごく普通で、そのままヘッダーへ載せると
// undici が `TypeError: Invalid header value` を投げ、理由が「要求が失敗しました」に埋もれる。
// アプリ側も設定値を `trim()` して読む（`src/lib/api/auth.ts`）ので、送り手側もそろえる
const baseUrl = process.env.MAINTENANCE_BASE_URL?.trim();
// プラットフォーム管理者トークン（この経路を叩ける唯一の資格情報）
const token = process.env.PLATFORM_ADMIN_TOKEN?.trim();
// 1 要求で判定するエージェント数（省略するとアプリ側の既定）
const agentBudget = process.env.MAINTENANCE_AGENT_BUDGET?.trim();

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
// アプリ側の外向き通信は `src/lib/outbound-url.ts` が同じ理由で https を強制している。
//
// **この一覧は `src/lib/outbound-url.ts` の写しで、共有していない。** このスクリプトは
// 依存ゼロの素の node で動かす前提なので（`npm ci --omit=dev` の配備でもスケジューラから
// 叩ける）、TypeScript のモジュールを import できない。写しなので**ずれうる** — ずれても
// 倒れる向きは「アプリが受けるループバックの綴りをスクリプトが拒む」か、その逆で、
// どちらも手元・テスト用の例外の範囲に収まる（本番は https なので影響しない）。
// アプリ側へ綴りを足すときはここも見ること（`src/` の検出網はこのファイルを見ない）
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

/**
 * 理由を出し、**合計も残して**から非 0 で終わる。
 *
 * **`process.exit(1)` だけだと合計の JSON が出ない。** 1 要求を包んだのは
 * 「`[maintenance:tick]` の 1 行も合計の JSON も残らない」のを避けるためだったが、
 * 途中の失敗で素に抜けると後者はやはり残らない — 400 要求ぶん歩いて `failed: 37` を
 * 積んだ末に接続が切れると、**その 37 件がどこにも出ない**（`failed` を数えている理由が消える）。
 * @param {string} message 失敗の理由
 * @param {unknown} [cause] 添える値（例外など）
 * @returns {never}
 */
function die(message, cause) {
  // 理由（名札付き）
  if (cause === undefined) console.error('[maintenance:tick]', message);
  else console.error('[maintenance:tick]', message, cause);
  // ここまでの合計（1 行 1 JSON）
  writeSummary();
  // 非 0 で終わる
  process.exit(1);
}

/**
 * ここまでの合計を 1 行 1 JSON で出す（アプリのログと同じ形）。
 *
 * **`process.stdout.write` ではなく同期の書き出しを使う。** 標準出力がパイプ（`tee` や
 * ログ収集）のときの書き込みは非同期で、`process.exit()` は**未完了の書き込みを捨てる** —
 * つまり `die()` が合計を出そうとしても、読み手が遅ければその行だけ消える
 * （この関数を足した理由＝「数えた取りこぼしを捨てない」が、まさにそこで破れる）。
 */
function writeSummary() {
  // ファイル記述子 1（標準出力）へ同期で書く
  writeSync(1, `${JSON.stringify({ event: 'maintenance.tick', ...total })}\n`);
}

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

  // 叩く先（**入口のパスを捨てない**）。`new URL('/api/v1/...', base)` は絶対パスなので
  // `https://host/ops` のような接頭辞付きの入口だと `/ops` が黙って落ち、毎回 404 になる
  // （しかも理由は「HTTP 404」としか出ないので、運用者は原因から遠ざけられる）。
  //
  // **組み立てはパスで行い、`href` に `/` を足す形にしない** — `href` はクエリや
  // フラグメントを含むので、`https://host/ops?x=1` だと `/` がクエリに付いて（`?x=1/`）
  // パスは `/ops` のままになり、相対参照が最終セグメントを落として接頭辞が消える
  // （フラグメント付きも同じ。`docs/deploy.md` は「接頭辞はそのまま使われる」と約束している）。
  // 入口のクエリ・フラグメントは API の呼び出しには関係しないので捨てる
  const endpoint = new URL(entry.origin);
  // 接頭辞の末尾に `/` を足してから足し込む（`/ops` → `/ops/api/v1/...`）
  endpoint.pathname = `${entry.pathname.replace(/\/+$/, '')}/api/v1/maintenance/run`;

  // 1 要求送る。**例外をそのまま外へ出さない** — 素の `await` で落とすと Node が未処理の
  // reject として stack trace だけを出し、`[maintenance:tick]` の 1 行も下の合計の JSON も
  // 残らない（他の失敗経路はすべて理由を名指ししているので、ここだけ扱いを変えない）
  let response;
  try {
    response = await fetchWithTimeout(
      endpoint,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      REQUEST_TIMEOUT_MS,
    );
  } catch (error) {
    // 理由を添えて落とす（中断・名前解決の失敗・接続断がここへ来る）
    die('要求が失敗しました', error);
  }
  // 2xx 以外は続けられない（状態が分からないまま叩き続けない）。
  // **本文も添える** — アプリ側の 422 は検証に失敗した項目を本文で名乗るので、ここで出すと
  // 「どの設定が悪いか」が運用者に伝わる（`MAINTENANCE_AGENT_BUDGET` を上限より大きくした等。
  // 上限そのものをこのスクリプトへ書き写すと、アプリ側を変えたとき写しだけが古くなる）。
  // 長い本文（HTML のエラーページ）で埋もれないよう頭だけにする
  if (!response.ok) {
    // 本文は読めないこともある（読めなければ空として扱う）
    const detail = await response.text().catch(() => '');
    die(`HTTP ${response.status} が返りました`, detail.slice(0, MAX_ERROR_BODY_CHARS));
  }
  // 進み具合を読む。**ここも包む** — 200 なのに JSON でない応答（ログイン画面・中間装置の
  // HTML）だと `json()` が投げ、素の `await` では理由が `SyntaxError` の stack trace だけに
  // なって `[maintenance:tick]` の 1 行も合計の JSON も残らない（上の `fetch` と同じ事情）
  let result;
  try {
    result = await response.json();
  } catch (error) {
    die('応答が JSON として読めません', error);
  }
  // **数として読めない応答はここで落とす（fail-closed）。** 200 を返す中間装置やログイン画面が
  // 別の JSON を返すと `total.failed += undefined` で NaN になり、`NaN > 0` は偽なので
  // **取りこぼしの唯一の出口が黙って 0 終了する**（しかも合計の JSON には `null` と出るので
  // 「データなし」に見える）。予算の環境変数と同じく、叩く前後で数を確かめる扱いにそろえる
  // **オブジェクトでなければ添字を引けない。** 本文が JSON の `null` だと `json()` は成功して
  // `result === null` になり、下の添字が `TypeError` を投げて**未処理の reject**になる
  // （名指しの 1 行も合計の JSON も残らない＝上の 2 つの包みで避けたのと同じ形）。
  // 配列・文字列・数値は添字が `undefined` になって下の検査で名指しされるので、`null` だけが
  // 門番の手前で落ちる非対称だった
  if (typeof result !== 'object' || result === null) {
    die(`応答がオブジェクトではありません（受け取った値: ${JSON.stringify(result)}）`);
  }
  for (const field of COUNTED_FIELDS) {
    if (!Number.isFinite(result[field])) {
      die(`応答の ${field} が数として読めません（受け取った値: ${JSON.stringify(result[field])}）`);
    }
  }
  total.requests += 1;
  total.rateLimitHitsDeleted += result.rateLimitHitsDeleted;
  total.tenantVisits += result.tenantsVisited;
  total.agentsEvaluated += result.agentsEvaluated;
  total.rulesEvaluated += result.rulesEvaluated;
  total.fired += result.fired;
  total.failed += result.failed;

  // **旗も形を確かめる。** ここは「もう呼ばなくてよいか」を決める 1 つの欄なので、上の
  // 数の検査と同じ扱いにする — 真偽値でない値（`"no"` / `1` / `{}` はどれも truthy）が来ると
  // **1 度も掃いていないのに 0 終了で「一巡を回し切った」と報告する**（数の検査を足した
  // 理由そのものが、それを使う側の欄で破れる）。カーソルも同じく形を確かめる
  if (typeof result.passComplete !== 'boolean') {
    die(
      `応答の passComplete が真偽値ではありません（受け取った値: ${JSON.stringify(result.passComplete)}）`,
    );
  }
  for (const field of ['nextTenantCursor', 'nextAgentCursor']) {
    // 文字列か `null` のどちらかでなければ続きの位置を送り返せない
    if (typeof result[field] !== 'string' && result[field] !== null) {
      die(
        `応答の ${field} が文字列でも null でもありません（受け取った値: ${JSON.stringify(result[field])}）`,
      );
    }
  }

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

// 回し切る前にループを抜けたのは異常（カーソルが進んでいない可能性がある）
if (!completed) die(`要求が ${MAX_REQUESTS} 回に達しました（一巡が終わりません）`);
// 判定の取りこぼしがあればスケジューラの失敗として見えるようにする
if (total.failed > 0) die(`判定できなかった件数: ${total.failed}`);
// 1 行 1 JSON（アプリのログと同じ形にして、収集側で同じように扱えるようにする）
writeSummary();
