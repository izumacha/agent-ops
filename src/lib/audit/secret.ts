// 監査ログのハッシュ連鎖に使う HMAC 鍵を環境変数から取る。
// **ドメイン層 (src/domain/audit/chain.ts) は鍵を引数で受け取る純粋関数**にしてあり、
// 「環境変数をどう読むか」はこのファイルだけが知る (ドメインを process.env から切り離す)。
import { ApiError } from '@/lib/api/errors';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { API_MESSAGES, AUDIT_HMAC_SECRET_MIN_LENGTH } from '@/lib/constants';
import { logEventThrottled } from '@/lib/log';
import { requireConfiguredSecret } from '@/lib/secret-gate';

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
  // 判断（空白の落とし方・未設定を先に見ること・短さの比較）は `requireConfiguredSecret` が持ち、
  // **どの出来事を出すかはここに残す**（語彙のキーをリテラルで書く。理由は secret-gate.ts）
  return requireConfiguredSecret(
    env[AUDIT_HMAC_SECRET_ENV],
    AUDIT_HMAC_SECRET_MIN_LENGTH,
    (reason) => {
      // 記録してから投げる（`ApiError` は応答へ写されるだけでログを通らない）。
      // **行は間引く**（直すまで続く状態なので 1 度きりにはせず、1 要求 1 行にもしない）
      if (reason === 'missing') logEventThrottled('audit.secret_not_configured');
      // 値はあるが短すぎる（未設定とは直し方が違うので別の出来事）
      else logEventThrottled('audit.secret_too_short');
      // どちらも 503 で倒す
      throw notConfiguredError();
    },
  );
}
