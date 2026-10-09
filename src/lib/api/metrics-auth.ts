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
// 代わりに `tests/route-wrapping.test.ts` の理由付きの表へ登録し、**この入口へ到達すること**と
// **`no-store` を宣言すること**を機械で要求している（署名 Webhook・画面側ルートと同じ扱い）。
//
// 設定が無いときは **503（fail-closed）**。鍵が無いときに素通しで数字を返す形は採らない
// （応答数とログの出来事数は、どの経路が叩かれているか・どの失敗が起きているかを外から読める）。
import { API_MESSAGES, METRICS_TOKEN_MIN_LENGTH } from '@/lib/constants';
import { secretsEqual } from '@/lib/tokens';
import { logEvent } from '@/lib/log';
import { extractBearerToken, invalidTokenError } from './auth';
import { ApiError } from './errors';
import { HTTP_STATUS } from './http-status';

// 短すぎる METRICS_TOKEN の警告を出したか（設定ミスは 1 度だけ知らせる。
// 毎リクエストで出すと、未認証の総当たりでエラーログを埋められる）
let warnedShortToken = false;

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
  // 環境変数を読む（運用者が設定する値なので信頼する。§9 の「環境変数は信頼値」）
  const configured = process.env.METRICS_TOKEN;
  // 未設定・空なら監視の入口は閉じたまま
  if (!configured) throw notConfiguredError();
  // 短すぎる値は設定ミスとみなして使わない（弱いトークンで運用の数字を読ませない）
  if (configured.length < METRICS_TOKEN_MIN_LENGTH) {
    // 1 度だけ警告する（設定を直す手掛かりは残すが、総当たりでログを埋められないようにする）
    if (!warnedShortToken) {
      warnedShortToken = true;
      logEvent('metrics.token_too_short');
    }
    // 設定が使えないので 503（「短い値でも通る」にはしない）
    throw notConfiguredError();
  }
  // Authorization ヘッダから Bearer トークンを取り出す（無ければ 401。auth.ts と同じ関数＝綴りが割れない）
  const token = extractBearerToken(request);
  // 定数時間で比べる（一致しなければ 401。理由は区別しない）
  if (!secretsEqual(token, configured)) throw invalidTokenError();
}

/**
 * テスト用に「短すぎる警告を出したか」を忘れる。
 * **本番の経路からは呼ばない**（`resetMetricsForTesting` と同じ扱いで、テストの独立性のためだけにある）。
 */
export function resetMetricsAuthForTesting(): void {
  // 本番で呼べると、短すぎる設定の警告が毎リクエスト出せるようになる（1 度だけにした理由が崩れる）
  if (process.env.NODE_ENV === 'production') {
    throw new Error('resetMetricsAuthForTesting は本番では使えません。');
  }
  // 次のテストでも 1 度目の警告が出るように戻す
  warnedShortToken = false;
}
