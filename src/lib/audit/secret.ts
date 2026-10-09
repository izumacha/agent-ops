// 監査ログのハッシュ連鎖に使う HMAC 鍵を環境変数から取る。
// **ドメイン層 (src/domain/audit/chain.ts) は鍵を引数で受け取る純粋関数**にしてあり、
// 「環境変数をどう読むか」はこのファイルだけが知る (ドメインを process.env から切り離す)。
import { ApiError } from '@/lib/api/errors';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { API_MESSAGES, AUDIT_HMAC_SECRET_MIN_LENGTH } from '@/lib/constants';
import { logEventThrottled } from '@/lib/log';

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
  // 未設定・空文字は設定されていないのと同じ。**記録してから投げる** —
  // `ApiError` は応答へ写されるだけでログを通らないので、ここで出さないと「鍵が無いので
  // 人の操作（停止・復帰・解決・ルール登録）と課金の反映がすべて 503」という状態が
  // **どの出口にも現れない**（系列には経路のラベルが無く、サーバーレスでは引きに行く収集
  // そのものが成り立たない）。**1 度きりにはしない**（直すまで続く状態なので、続いている
  // ことと規模を残す。理由は `logEventThrottled`）。**記録はここで行い、例外を作る関数には
  // 置かない** — 名前と戻り値が「副作用の無い組み立て」を約束しているので、投げずに組み立てる
  // 呼び出し元（分岐で返す・`Promise.reject(...)` へ渡す・テストの補助）が身に覚えのない
  // 「鍵が無い」の行を書いてしまう（`checkSameOriginAction` へ改名したのと同じ理由）
  if (configured === undefined || configured === '') {
    logEventThrottled('audit.secret_not_configured');
    throw notConfiguredError();
  }
  // 短すぎる鍵は総当たりで求められるので使わない (求められたら連鎖を作り直せる)
  if (configured.length < AUDIT_HMAC_SECRET_MIN_LENGTH) {
    // **「未設定」とは別の出来事**（直し方が「変数を足す」ではなく「値を作り直す」なので、
    // 同じ `event` だとログからも系列からも区別できない）
    logEventThrottled('audit.secret_too_short');
    throw notConfiguredError();
  }
  // 使える鍵
  return configured;
}
