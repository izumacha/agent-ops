// 監査ログのハッシュ連鎖に使う HMAC 鍵を環境変数から取る。
// **ドメイン層 (src/domain/audit/chain.ts) は鍵を引数で受け取る純粋関数**にしてあり、
// 「環境変数をどう読むか」はこのファイルだけが知る (ドメインを process.env から切り離す)。
import { ApiError } from '@/lib/api/errors';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { API_MESSAGES, AUDIT_HMAC_SECRET_MIN_LENGTH } from '@/lib/constants';

// 鍵を入れる環境変数の名前 (ここが唯一の参照元。.env.example とドキュメントはこの名前を指す)
export const AUDIT_HMAC_SECRET_ENV = 'AUDIT_HMAC_SECRET';

// 設定が使えないときの例外 (503)。何が足りないかは応答に出さない
function notConfiguredError(): ApiError {
  // 503: 設定が無いので今はこの操作を行えない (上流未設定と同じ扱い)
  return new ApiError(HTTP_STATUS.SERVICE_UNAVAILABLE, API_MESSAGES.auditNotConfigured);
}

/**
 * HMAC 鍵を返す。未設定・空・短すぎは **503 を投げる (fail-closed)**。
 *
 * 鍵が無いときに「鍵なしのハッシュで代用する」「ハッシュを空にして書く」はどちらも採らない。
 * 前者は DB への書き込み権限を得た相手が連鎖を作り直せるので検知にならず、後者は
 * 検証できない行を混ぜることになる。**監査ログを書けないなら、その操作自体を失敗させる**のが
 * 正しい倒れ方 (§9 の fail-closed。UC-09 の事後条件「監査ログに残る」を守れないまま成功を返さない)。
 */
export function auditHmacSecret(env: NodeJS.ProcessEnv = process.env): string {
  // 環境変数を読み、前後の空白を落とす (貼り付けの改行で長さ判定が狂わないように)
  const configured = env[AUDIT_HMAC_SECRET_ENV]?.trim();
  // 未設定・空文字は設定されていないのと同じ
  if (configured === undefined || configured === '') throw notConfiguredError();
  // 短すぎる鍵は総当たりで求められるので使わない (求められたら連鎖を作り直せる)
  if (configured.length < AUDIT_HMAC_SECRET_MIN_LENGTH) throw notConfiguredError();
  // 使える鍵
  return configured;
}
