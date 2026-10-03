// ガードレールの発火を外へ知らせる (Webhook / メール)。
//
// **宛先はテナントから受け取らず環境変数だけが決める** (上流 LLM の接続先と同じ流儀。ADR-0007)。
// 利用者が入れた URL へサーバが要求を出す形にすると SSRF の入口になるため、Step4 では
// 運用者が設定する 1 組に絞っている (テナントごとの宛先管理は Step5/6。ADR-0010 に宿題として記録)。
//
// **通知は fail-open。** 送れなくても停止は取り消さない (§9 の fail-closed は「止める側」に効かせる)。
// 通知の失敗で `evaluateGuardrails` を失敗させると、Webhook の受け手が落ちているあいだ
// 「超過しても止まらない」状態になり、守るべきものが守れなくなる。
import { createHmac } from 'node:crypto';
import {
  NOTIFY_MAX_RESPONSE_BYTES,
  NOTIFY_SIGNATURE_HEADER,
  NOTIFY_SIGNING_SECRET_MIN_LENGTH,
  NOTIFY_TIMEOUT_MS,
} from '@/lib/constants';
import { describeError } from '@/lib/describe-error';
import { parseOutboundUrl } from '@/lib/outbound-url';
import { readStreamWithinByteLimit } from '@/lib/stream-bytes';

// 宛先の種類 (環境変数の名前と対になる)
export const NotifyChannel = {
  // Webhook (任意の受け手へ JSON を POST する)
  webhook: 'webhook',
  // メール (同じ形の署名付き POST をメール中継のエンドポイントへ送る。SMTP は持ち込まない)
  email: 'email',
} as const;
// NotifyChannel の値の型
export type NotifyChannel = (typeof NotifyChannel)[keyof typeof NotifyChannel];

// 種類ごとの宛先を入れる環境変数の名前。**ここが唯一の参照元**で、.env.example もこの名前を指す
export const NOTIFY_URL_ENV: Readonly<Record<NotifyChannel, string>> = {
  [NotifyChannel.webhook]: 'NOTIFY_WEBHOOK_URL',
  [NotifyChannel.email]: 'NOTIFY_MAIL_WEBHOOK_URL',
};

// 署名鍵を入れる環境変数の名前
export const NOTIFY_SIGNING_SECRET_ENV = 'NOTIFY_SIGNING_SECRET';

/** 通知として送る内容。**機微情報を入れない** (監査ログの payload と同じ規律) */
export interface NotifyPayload {
  // どのテナントで起きたか
  tenantId: string;
  // どのエージェントが対象か
  agentId: string;
  // 発火したルールの種別 (cost / error_rate / quality)
  kind: string;
  // 記録したインシデントの id (受け手が API で詳細を引ける)
  incidentId: string;
  // 人が読む要約 (インシデントの summary と同じ文)
  summary: string;
  // エージェントを停止したか
  suspended: boolean;
  // 発生時刻 (ISO 8601)
  occurredAt: string;
}

/** 1 つの宛先への送信結果。**呼び出し側は結果を見るが、失敗しても処理を止めない** */
export type NotifyResult =
  // 送って受け手が 2xx を返した
  | { status: 'delivered'; channel: NotifyChannel }
  // 宛先が設定されていない (運用者が設定していないだけなので異常ではない)
  | { status: 'not_configured'; channel: NotifyChannel }
  // 署名鍵が無い・短すぎるので送らなかった (署名できない通知は送らない)
  | { status: 'unsigned'; channel: NotifyChannel }
  // 宛先の形が受け付けられない (http の別ホスト・資格情報付き URL など)
  | { status: 'rejected_target'; channel: NotifyChannel; reason: string }
  // 送ったが受け手が 2xx を返さなかった・届かなかった
  | { status: 'failed'; channel: NotifyChannel };

// 署名鍵を読む (未設定・短すぎは null = 送らない)
function signingSecret(env: NodeJS.ProcessEnv): string | null {
  // 環境変数を読み、前後の空白を落とす
  const configured = env[NOTIFY_SIGNING_SECRET_ENV]?.trim();
  // 未設定・空は無いのと同じ
  if (configured === undefined || configured === '') return null;
  // 短すぎる鍵は総当たりで求められるので使わない
  return configured.length < NOTIFY_SIGNING_SECRET_MIN_LENGTH ? null : configured;
}

/**
 * 1 つの宛先へ送る。**例外を外へ出さない** (通知の失敗で停止を取り消さないため)。
 *
 * 守っていること:
 *   - 宛先は環境変数だけが決める (テナントからは受け取らない)
 *   - https のみ (非本番のループバック http を除く。`parseOutboundUrl` が唯一の規則)
 *   - **リダイレクトを追わない** — 追うと受け手が接続先を書き換えられる (署名付きの本文が別ホストへ行く)
 *   - タイムアウトを置く (受け手が黙り込んでも発火の処理が止まらない)
 *   - 応答本文は上限まで読んで捨てる (受け手が無限に送ってきてもメモリを食わない)
 */
async function sendTo(
  channel: NotifyChannel,
  payload: NotifyPayload,
  env: NodeJS.ProcessEnv,
): Promise<NotifyResult> {
  // 宛先の設定を読む
  const raw = env[NOTIFY_URL_ENV[channel]]?.trim();
  // 設定が無ければ送らない (異常ではないので失敗にもしない)
  if (raw === undefined || raw === '') return { status: 'not_configured', channel };
  // 宛先の形を確かめる (スキームと資格情報の規則は共有モジュールが持つ)
  const parsed = parseOutboundUrl(raw, env);
  // 受け付けられない形なら送らない (理由は呼び出し側がログに残す)
  if (!parsed.ok) return { status: 'rejected_target', channel, reason: parsed.reason };
  // 署名鍵を読む
  const secret = signingSecret(env);
  // **署名できないなら送らない。** 署名なしの通知は受け手がなりすましと区別できないので、
  // 「送らない」側に倒す (§9 fail-closed)
  if (secret === null) return { status: 'unsigned', channel };
  // 送る本文 (署名の対象もこの文字列そのもの)
  const body = JSON.stringify(payload);
  // 本文の HMAC-SHA256 を 16 進で求め、受け手が検証できる形のヘッダに載せる
  const signature = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  // 時間切れで打ち切るための合図
  const controller = new AbortController();
  // 上限時間で打ち切る
  const timer = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS);
  try {
    // 送る (リダイレクトは追わない)
    const response = await fetch(parsed.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [NOTIFY_SIGNATURE_HEADER]: `sha256=${signature}`,
      },
      body,
      // **manual** にすると 3xx をそのまま受け取る (追わないので接続先は動かない)
      redirect: 'manual',
      signal: controller.signal,
    });
    // 応答本文は上限まで読んで捨てる (読まないと接続が滞留する実装もあるため、読んでから捨てる)。
    // **上限を超えたら下層も解放する** (cancelOnOverflow) — 読むのをやめるだけだと応答ボディが
    // 未消費のまま残り、ソケットと fd がタイムアウトまで解放されない (上流の応答を読む
    // src/lib/proxy/upstream.ts と同じ事情で、そちらは実測で確認済み)。受け手が毎回 64KiB を
    // 超える本文を返すと、発火 1 件ごとに 2 本ずつ fd が積まれる
    //
    // **本文の読み取り失敗で「届かなかった」にしない。** 受け手が 2xx を返した時点で通知は
    // 届いており、その後の切断や時間切れは配信の成否と無関係。`readStreamWithinByteLimit` は
    // 読み取りの失敗を投げるので、囲まないと下の catch へ落ちて `failed` になり、届いた通知に
    // 対して「受け手へ届きませんでした」と記録する (運用者が無い障害を追うことになる)
    if (response.body !== null) {
      try {
        await readStreamWithinByteLimit(response.body, NOTIFY_MAX_RESPONSE_BYTES, {
          cancelOnOverflow: true,
        });
      } catch (error) {
        // 読み捨てに失敗したことは残す (握り潰さない。§6) が、配信の判定には使わない
        console.error('[notify] 応答本文を読み捨てられませんでした', describeError(error));
      }
    }
    // 2xx 以外は届かなかったものとして扱う (3xx も「追わない」ので失敗)
    return response.ok ? { status: 'delivered', channel } : { status: 'failed', channel };
  } catch (error) {
    // 接続不能・時間切れ・打ち切りはすべて「届かなかった」。**例外を外へ出さない**
    console.error('[notify] 通知を送れませんでした', describeError(error));
    return { status: 'failed', channel };
  } finally {
    // 成功・失敗どちらでもタイマーを解除する (§8 リソースを確実に解放する)
    clearTimeout(timer);
  }
}

/**
 * 設定されている宛先すべてへ送る。**呼び出し側は結果を待つが、失敗で処理を止めない。**
 *
 * **停止より後に呼ぶこと。** Webhook の往復を「発火から停止まで」の計測に入れないため
 * (受け入れ基準は 3 秒で、受け手の応答時間はこちらで決められない)。
 */
export async function notifyGuardrailIncident(
  payload: NotifyPayload,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NotifyResult[]> {
  // 2 つの宛先へ並行に送る (片方が遅くてももう片方を待たせない)
  const results = await Promise.all(
    Object.values(NotifyChannel).map((channel) => sendTo(channel, payload, env)),
  );
  // 宛先の形が受け付けられなかったものはサーバログに残す (運用者が直せるようにする)。
  //
  // **URL そのものも理由の値も実引数に混ぜない。** ログへ出してよい形は
  // 「文字列リテラル / 置換の無いテンプレート / describeError(...) / 許可表の識別子だけのテンプレート」に
  // 限られていて (tests/error-logging.test.ts が構文で見張る)、`{ channel, reason }` のような
  // オブジェクトは通らない。宛先の URL はクエリに受け手のトークンが載っている形が普通にあるので、
  // 出さない方が正しい (§9)。**代わりに直すべき環境変数の名前を文言に書く** —
  // 運用者にとっては `{channel: 'webhook'}` より「どの変数を直すか」のほうが役に立つ
  for (const result of results) {
    // **宛先が設定されていないものだけは出さない** (送るものが無いだけで、異常ではない)。
    // それ以外の「届かなかった」はすべて残す — **以前は rejected_target だけを出していた**ので、
    // (a) 宛先は正しいが署名鍵が短い (`unsigned`)、(b) 受け手が 2xx 以外を返した (`failed`) の
    // 2 つが**ログに 1 行も残らず**消えていた。どちらも「発火して停止したのに通知が 1 通も届かず、
    // 理由がどこにも無い」状態になる (§6 エラーを握り潰さない)。
    // なお `failed` のうち例外で終わったものは sendTo 側でも 1 行出る (原因が分かる形で残す)
    if (result.status === 'not_configured' || result.status === 'delivered') continue;
    // Webhook 側か、メール中継側かで文言を分ける (直すべき環境変数の名前を文言に書く)
    const isWebhook = result.channel === NotifyChannel.webhook;
    // 宛先の形が受け付けられないとき
    if (result.status === 'rejected_target') {
      if (isWebhook) {
        console.error(
          '[notify] NOTIFY_WEBHOOK_URL の形が受け付けられません (https か非本番のループバック http のみ・資格情報付き URL は不可)',
        );
      } else {
        console.error(
          '[notify] NOTIFY_MAIL_WEBHOOK_URL の形が受け付けられません (https か非本番のループバック http のみ・資格情報付き URL は不可)',
        );
      }
      continue;
    }
    // 署名鍵が無い・短いとき (宛先は設定されているので、運用者は送るつもりでいる)。
    // **必要な長さの値を文言へ書き写さない** — ログの実引数は文字列リテラルに限られている
    // (`tests/error-logging.test.ts`) ので補間もできず、写すと定数を変えたときに案内だけが
    // 誤りになる。代わりに**定数の名前**を書く (`evaluate.ts` が環境変数の名前を書くのと同じ形)
    if (result.status === 'unsigned') {
      if (isWebhook) {
        console.error(
          '[notify] NOTIFY_SIGNING_SECRET が未設定か短いため NOTIFY_WEBHOOK_URL へ送りませんでした (必要な長さは src/lib/constants.ts の NOTIFY_SIGNING_SECRET_MIN_LENGTH)',
        );
      } else {
        console.error(
          '[notify] NOTIFY_SIGNING_SECRET が未設定か短いため NOTIFY_MAIL_WEBHOOK_URL へ送りませんでした (必要な長さは src/lib/constants.ts の NOTIFY_SIGNING_SECRET_MIN_LENGTH)',
        );
      }
      continue;
    }
    // 受け手へ届かなかったとき (2xx 以外・3xx・接続不能・時間切れ)
    if (isWebhook) {
      console.error('[notify] NOTIFY_WEBHOOK_URL の受け手へ通知が届きませんでした');
    } else {
      console.error('[notify] NOTIFY_MAIL_WEBHOOK_URL の受け手へ通知が届きませんでした');
    }
  }
  // 呼び出し側が監査ログへ「送れたか」を残せるように結果を返す
  return results;
}
