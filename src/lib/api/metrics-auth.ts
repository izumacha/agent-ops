// `/metrics` の認証。**監視専用の読み取りトークン**（環境変数 `METRICS_TOKEN`）で守る。
//
// **なぜプラットフォーム管理者トークンを使わないか（§9 最小権限）。** あの資格情報は
// `POST /tenants`（**応答に新しいテナントの admin トークンの平文が載る**）と
// `PATCH /tenants/{tenantId}`（プランと課金の紐付けの変更）も通る。監視の収集エージェントが
// するのは「数字を読む」ことだけなので、同じトークンを配ると**収集側の設定ファイル・
// 収集サーバの侵害がそのままテナント作成とプラン変更の権限になる**。`docs/deploy.md` 自身が
// 「このトークンは配らない」と書いているので、配れという手順と文書が矛盾してもいた。
//
// **`route()` を通らない。** `route()` の認証は Bearer トークンから `Principal`（テナント内の
// ユーザー／プラットフォーム管理者／エージェント）を決める仕組みで、このトークンはそのどれでもない
// （テナントを持たず、役割も持たない）。`Principal` の種類を 1 つ増やすと RBAC の許可表・プランの
// ゲート・テナント境界の検査がすべてその種類を扱わねばならず、「どこでも通る主体」を足すことになる。
// 代わりに `tests/route-wrapping.test.ts` の理由付きの表へ登録し、**この入口へ到達すること**を
// 機械で要求している（署名 Webhook・画面側ルートと同じ扱い）。**キャッシュ制御と応答の
// 数え上げはこの表では要求しない** — 包むラッパー（`withResponseCount`）が全応答へ付けるので、
// 経路ごとではなく全ルート共通の 2 本（印の付いた export であること・合成した応答に実際に
// ヘッダが付くこと）が固定する。ここを「表が `no-store` も要求する」と書くと、4 本目の
// 素通りルートを足す人が在りもしない経路ごとの門番を頼りにする。
//
// 設定が無いときは **503（fail-closed）**。鍵が無いときに素通しで数字を返す形は採らない
// （応答数とログの出来事数は、どの経路が叩かれているか・どの失敗が起きているかを外から読める）。
import { API_MESSAGES, METRICS_TOKEN_MIN_LENGTH } from '@/lib/constants';
import { secretsEqual } from '@/lib/tokens';
import { logEventOnce, logEventThrottled } from '@/lib/log';
import { bearerTokenOrNull, invalidTokenError, unauthorizedError } from './auth';
import { ApiError } from './errors';
import { HTTP_STATUS } from './http-status';

/**
 * 設定が使えないときの例外（503）。何が足りないかは応答に出さない。
 * @returns 503 の例外
 */
function notConfiguredError(): ApiError {
  // 503: 設定が無いので今はこの操作を行えない（課金の鍵・監査ログの鍵と同じ扱い）
  return new ApiError(HTTP_STATUS.SERVICE_UNAVAILABLE, API_MESSAGES.metricsNotConfigured);
}

/**
 * 監視用トークンを照合する。合わなければ例外を投げる（通れば何も返さない）。
 *
 * - 未設定・短すぎ → **503**（設定ミス。誰も通れない＝fail-closed）
 * - ヘッダが無い・形が違う → **401**
 * - 値が合わない → **401**（比較は定数時間。早期終了すると一致した長さから 1 文字ずつ詰められる）
 * @param request 受け取った要求
 */
export function assertMetricsToken(request: Request): void {
  // 環境変数を読み、**前後の空白を落とす**（§9 の「環境変数は信頼値」なので中身は信頼する）。
  // **落とさないと設定漏れより厄介な壊れ方になる** — 秘密を入れる 2 つの兄弟
  // （`auditHmacSecret` / `billingWebhookSecret`）は同じ理由で落としており、ここだけ
  // 落としていなかった。貼り付けの改行が 1 つ混ざると、長さの門番は通る一方
  // `secretsEqual` はハッシュ同士の比較なので**完全な不一致**になり、収集側が正しい値を
  // 持っていても永久に 401。しかも唯一の信号である `metrics.token_rejected` の文言は
  // 「収集側の設定ミス、または総当たり」と案内するので、運用者は逆側を調べることになる
  const configured = process.env.METRICS_TOKEN?.trim();
  // 未設定・空なら監視の入口は閉じたまま。**1 度だけ記録する** —
  // ここだけログを出していなかったので、**いちばん起きやすい設定漏れが唯一どの出口にも
  // 現れない**状態だった（もう 1 つの痕跡である `agentops_http_responses_total{status="503"}`
  // は `/metrics` 経由でしか読めず、その `/metrics` 自身が 503 なので到達できない）。
  // **1 プロセスに 1 度**にするのは「短すぎる値」の警告と同じ理由（設定の通知なので
  // 2 件目以降に情報が無く、未認証で誰でも叩ける経路なので毎回出すと埋められる）
  if (!configured) {
    logEventOnce('metrics.token_not_configured');
    throw notConfiguredError();
  }
  // 短すぎる値は設定ミスとみなして使わない（弱いトークンで運用の数字を読ませない）
  if (configured.length < METRICS_TOKEN_MIN_LENGTH) {
    // 1 度だけ警告する（設定を直す手掛かりは残すが、総当たりでログを埋められないようにする）
    logEventOnce('metrics.token_too_short');
    // 設定が使えないので 503（「短い値でも通る」にはしない）
    throw notConfiguredError();
  }
  // Authorization ヘッダから Bearer トークンを取り出す（無ければ null。auth.ts と同じ関数＝綴りが割れない）。
  // **投げさせずに受け取る** — `extractBearerToken` が投げる形にしていた頃は、ヘッダが
  // 無い／`Basic` などの非 Bearer のときに下のログへ一度も届かなかった（実測: ヘッダ無しと
  // `Authorization: Basic …` はどちらも 401 なのにログは 0 行で、**いちばん起きやすい
  // 収集側の設定ミス**（`bearer_token` を書き忘れた・基本認証にした）だけが無言だった）
  const token = bearerTokenOrNull(request);
  // 断る理由を先に決める（**401 のチャレンジは 2 種類ある** — 資格情報が無い場合は
  // `error` を付けず、値が合わない場合は `invalid_token`。RFC 6750 の区別はそのまま保つ）。
  // 比較は定数時間（一致しなければ 401。形・長さ・一致の理由は区別して返さない）
  const failure =
    token === null
      ? unauthorizedError()
      : secretsEqual(token, configured)
        ? null
        : invalidTokenError();
  // 断るなら 1 行残してから投げる（**ログは 1 か所**。2 つの経路で書き写さない）
  if (failure !== null) {
    // **1 行残す。** ApiError は `withResponseCount` の中でログを通らない（応答へ写すだけ）ので、
    // ここで出さないと**どの出口にも現れない**（応答の系列には出るが、経路を示すラベルが無いので
    // 期限切れトークンの 401 と区別できず、サーバーレスでは引きに行く収集そのものが
    // 成り立たない＝`docs/deploy.md`）。収集エージェントの設定ミスは無言にしない。
    // **行は間引く**（`logEventThrottled`。窓の中の通算件数が 2 の冪の回だけ出し、その件数を
    // 行の `occurrence` に載せる）— 未認証で誰でも叩ける経路なので、1 要求 1 行だと匿名の
    // 相手がログの量を好きなだけ増やせる。**数えるのは毎回**なので率は
    // `agentops_log_events_total` に残る（理由は `logEventThrottled` の説明）
    logEventThrottled('metrics.token_rejected');
    throw failure;
  }
}
