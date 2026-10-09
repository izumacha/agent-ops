// 受信 Webhook の署名検証（Step6）。**Stripe の SDK は入れず、署名の形だけを自前で検証する**
// （ADR-0012）。依存を 1 つ増やすと `npm audit` / dependabot / API バージョンの固定という
// 規約がまるごと増えるのに、要るのは「HMAC-SHA256 ＋ 定数時間比較」だけなので自前で足りる。
//
// **送信側（`src/lib/notify/send.ts`）と同じ流儀**にしてある: 鍵は環境変数から取り、
// 未設定なら送らない／受けない（fail-closed）。比較は必ず定数時間で行う。
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from '@/lib/api/errors';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { API_MESSAGES, BILLING_WEBHOOK_SECRET_MIN_LENGTH } from '@/lib/constants';
import { logEventOnce } from '@/lib/log';

// 鍵を入れる環境変数の名前（ここが唯一の参照元。.env.example とドキュメントはこの名前を指す）
export const BILLING_WEBHOOK_SECRET_ENV = 'STRIPE_WEBHOOK_SECRET';
// 署名が載るヘッダの名前（Stripe の仕様）
export const BILLING_SIGNATURE_HEADER = 'Stripe-Signature';
/**
 * 署名のタイムスタンプを受け付ける幅（秒）。
 *
 * **これが無いと、1 度盗んだ正しい署名付きの本文を何年後でも再生できる**（リプレイ）。
 * 受信記録の一意制約（`BillingEvent`）も同じイベント ID の再送は弾くが、記録を消した後や
 * **別のイベント ID を持つ古い本文**には効かないので、時刻の幅は別に要る。
 * 5 分は Stripe が推奨する既定値で、時計のずれと再送の遅れを吸収できる幅。
 */
export const BILLING_SIGNATURE_TOLERANCE_SECONDS = 300;

// 署名ヘッダの長さの上限（鍵のローテーション中でも v1 は数本なので、これで足りる）
const BILLING_SIGNATURE_HEADER_MAX_LENGTH = 1_024;

/** 署名ヘッダを分解した形（`t=<秒>,v1=<16 進>,v1=<16 進>` の並び） */
export interface ParsedBillingSignature {
  // 署名した時刻（UNIX 秒）
  timestamp: number;
  // v1 の署名（鍵のローテーション中は複数載りうるので配列で持つ）
  signatures: string[];
}

/**
 * 署名ヘッダを分解する。形が違えば `null`（= 検証を通さない）。
 *
 * **寛容に読まない** — `t` が数値でない・`v1` が 1 つも無い・16 進でない、はすべて拒否する。
 * 「読めなかったぶんを無視して先へ進む」形にすると、壊れたヘッダが「署名なし」ではなく
 * 「検証を通った」に化けうる（§9 fail-closed）。
 */
export function parseBillingSignature(header: string | null): ParsedBillingSignature | null {
  // ヘッダが無ければ検証できない
  if (header === null) return null;
  // 長さの上限を置く（信頼できない入力に正規表現を当てる前に縛る。§9 ReDoS）。
  // 鍵のローテーション中でも v1 は数本なので、これを超える長さは正規の署名ではない
  if (header.length > BILLING_SIGNATURE_HEADER_MAX_LENGTH) return null;
  // 時刻と署名を集める
  let timestamp: number | null = null;
  const signatures: string[] = [];
  // `,` 区切りの各要素を見る
  for (const part of header.split(',')) {
    // `=` で 1 回だけ割る（値に `=` は現れないが、現れても後ろをまとめて値として扱う）
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    // 鍵と値（前後の空白は落とす）
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    // 時刻（10 進の整数だけを受ける。負数・小数・指数表記は拒否）
    if (key === 't') {
      // 数字だけで構成されていること
      if (!/^[0-9]{1,20}$/.test(value)) return null;
      // 数値へ直す（桁を縛ってあるので安全）
      timestamp = Number(value);
      continue;
    }
    // v1 の署名（SHA-256 の 16 進 = 64 文字）
    if (key === 'v1') {
      if (!/^[0-9a-f]{64}$/.test(value)) return null;
      signatures.push(value);
    }
  }
  // 時刻が読めない・署名が 1 つも無いなら検証できない
  if (timestamp === null || signatures.length === 0) return null;
  // 分解できた
  return { timestamp, signatures };
}

/** 署名を検証した結果（失敗の理由は**応答に出さない**。ログにも値そのものは出さない） */
export type BillingSignatureResult = 'ok' | 'malformed' | 'stale' | 'mismatch';

/**
 * 署名を検証する純粋関数（時刻も鍵も引数で受ける）。
 *
 * 署名の対象は **`<t>.<本文そのまま>`**。本文は**生のテキスト**でなければならない
 * （JSON を解析して組み立て直すとキーの順や空白が変わり、正しい署名でも一致しなくなる）。
 *
 * @param header 署名ヘッダの中身
 * @param payload 受信した本文の生テキスト
 * @param secret 共有シークレット
 * @param nowSeconds 現在時刻（UNIX 秒）
 */
export function verifyBillingSignature(
  header: string | null,
  payload: string,
  secret: string,
  nowSeconds: number,
): BillingSignatureResult {
  // ヘッダを分解する（形が違えば検証しない）
  const parsed = parseBillingSignature(header);
  if (parsed === null) return 'malformed';
  // 時刻の幅を見る（**過去側だけでなく未来側も縛る** — 未来の時刻を許すと、
  // 時計を進めて作った署名が幅の分だけ長く有効になる）
  if (Math.abs(nowSeconds - parsed.timestamp) > BILLING_SIGNATURE_TOLERANCE_SECONDS) {
    return 'stale';
  }
  // 期待する署名（鍵は環境変数、対象は `<t>.<本文>`）
  const expected = createHmac('sha256', secret)
    .update(`${parsed.timestamp}.${payload}`)
    .digest('hex');
  // 期待値のバイト列（長さは 32 バイト固定）
  const expectedBytes = Buffer.from(expected, 'hex');
  // 載っている署名のどれかが一致すれば通す（鍵のローテーション中は複数載る）。
  // **必ず定数時間で比べる** — 早期終了する比較だと、一致した長さから署名を 1 バイトずつ
  // 詰められる（§9 の「検証は定数時間比較で行う」）
  const matched = parsed.signatures.some((signature) =>
    timingSafeEqual(Buffer.from(signature, 'hex'), expectedBytes),
  );
  // 一致したかどうか
  return matched ? 'ok' : 'mismatch';
}

// 設定が使えないときの例外（503）。何が足りないかは応答に出さない
function notConfiguredError(): ApiError {
  // **設定ミスを 1 度だけ記録する。** `ApiError` は `withResponseCount` の中でログを通らない
  // （応答へ写すだけ）ので、ここで出さないと**どの出口にも現れない** — 受信 Webhook は
  // 未認証なので 503 を見た運用者がいるとは限らず、残る痕跡は
  // `agentops_http_responses_total{status="503"}` だけだが、系列には経路のラベルが無く
  // サーバーレスでは引きに行く収集そのものが成り立たない（`docs/deploy.md`）。
  // 無言だと、鍵の設定漏れで**全配信が 503 → 事業者がバックオフののちエンドポイントを無効化**し、
  // 解約の反映が止まって有料の権限が残り続ける（`metrics.token_not_configured` と同じ形）。
  // **1 度だけ**にするのは設定の通知で 2 件目以降に情報が無いから（理由は `logEventOnce`）
  logEventOnce('billing.secret_not_configured');
  // 503: 設定が無いので今はこの操作を行えない（監査ログの鍵と同じ扱い）
  return new ApiError(HTTP_STATUS.SERVICE_UNAVAILABLE, API_MESSAGES.billingNotConfigured);
}

/**
 * Webhook の共有シークレットを返す。未設定・空・短すぎは **503 を投げる（fail-closed）**。
 *
 * **「鍵が無いときは検証せずに受け入れる」は採らない** — 受信 Webhook はプランを書き換える
 * 経路なので、検証を飛ばすと誰でも任意のテナントを enterprise へ上げられる。
 * 受けられないなら 503 を返して事業者に再送させるのが正しい倒れ方（§9）。
 */
export function billingWebhookSecret(env: NodeJS.ProcessEnv = process.env): string {
  // 環境変数を読み、前後の空白を落とす（貼り付けの改行で長さ判定が狂わないように）
  const configured = env[BILLING_WEBHOOK_SECRET_ENV]?.trim();
  // 未設定・空文字は設定されていないのと同じ
  if (configured === undefined || configured === '') throw notConfiguredError();
  // 短すぎる鍵は総当たりで求められる（求められたら任意の本文を署名できる）
  if (configured.length < BILLING_WEBHOOK_SECRET_MIN_LENGTH) throw notConfiguredError();
  // 使える鍵
  return configured;
}
