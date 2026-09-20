// 上流 (Anthropic / OpenAI) のエラー本文を、利用者へ返してよい形へ絞り込む。
//
// **なぜ要るか**: 上流の 4xx をそのまま返すと、プラットフォーム側の上流アカウントの状態が
// 全テナントへ漏れる。実測で確認した例 (どれもステータスは 4xx):
//   - Anthropic の残高不足は **400**「Your credit balance is too low … go to Plans & Billing」
//   - OpenAI の model_not_found は **404**「… your organization <組織名> does not have access to it」
//   - 上限超過の詳細 (契約ティア・tokens/min) が **400 / 413** の本文に載る
// これらは「送り主の要求についての診断」ではなく**契約・課金・組織の情報**で、上流のアカウントは
// 全テナントで共有なので、有効な API キーを 1 本持つ相手が他テナントぶんまで観測できてしまう。
//
// **ステータス番号では選り分けられない** — 上の 400 は送り主の本文が悪いときの 400 と同じ番号。
// 区別できるのは**本文の中のどの項目か**だけなので、機械可読な項目だけを許可リストで通し、
// 自由記述 (message) は自前の定型文へ差し替える (§9 fail-closed: 迷うものは出さない)。
//
// **残る境界**: 通す値は綴りで絞るが、`code` / `type` は**ベンダーの分類語彙**なので、
// `billing_hard_limit_reached` や `model_not_found` のように「共有している上流アカウントの
// 状態」をカテゴリとして示す値は残る。これを完全に塞ぐには「既知の安全なコードだけの閉じた
// 語彙」にするしかなく、ベンダーが値を増やすたびに診断が黙って消える (別の壊れ方) ので採らない。
// 形では弾けないと理解したうえで受け入れている (ADR-0007 決定 7)。
import { API_MESSAGES } from '@/lib/constants';

// 通してよい項目の名前。いずれも機械可読な識別子で、アカウントの状態を語らない:
//   type  … エラーの種別 (invalid_request_error / not_found_error など)
//   code  … 細かい理由コード (context_length_exceeded など)
//   param … 問題のあった入力項目の名前 (messages / max_tokens など)
const SAFE_ERROR_FIELDS = ['type', 'code', 'param'] as const;

// 値が「そのまま返してよい識別子」か。**長さではなく綴りで絞る** —
// 長さだけを見ていたときは 100 文字以内の散文が素通しし、実測で
// `code: 'quota for org-ACME exhausted; plan=Enterprise; …'` や
// `param: 'organization ACME Corp (tier: enterprise) has no access …'` がそのまま中継された。
// 英数字・アンダースコア・ドット・ハイフンと、JSON パス用の角括弧だけを許す
// (実在のベンダー値 invalid_request_error / context_length_exceeded / messages[0].content は通る)。
// 空白を許さないので散文は入らず、制御文字・孤立サロゲートも同時に落ちる
// (このリポジトリが他のすべての文字列に対して課している不変条件と揃う)。
// 固定長の繰り返しなので ReDoS の余地は無い (§9)
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_.\-[\]]{1,64}$/;

// オブジェクト (連想配列) として読めるかどうか
function asRecord(value: unknown): Record<string, unknown> | null {
  // null でないオブジェクトで、配列でないものだけ
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  // 連想配列として扱う
  return value as Record<string, unknown>;
}

// 識別子として通してよい文字列だけを取り出す (それ以外は undefined)
function safeIdentifier(value: unknown): string | undefined {
  // 文字列でなければ通さない
  if (typeof value !== 'string') return undefined;
  // 識別子の綴りに収まるものだけを通す (fail-closed)
  return SAFE_IDENTIFIER_PATTERN.test(value) ? value : undefined;
}

/**
 * 上流のエラー本文から、返してよい項目だけを取り出して組み直す。
 * ベンダーの形 (`{ error: { type, code, param, message } }`) は保ったまま、
 * 自由記述の message を自前の定型文へ差し替える (ベンダーの SDK が読める形を保つため)。
 * @param parsed 上流の本文を JSON として解釈した値 (解釈できていなければ null)
 * @returns 利用者へ返してよい本文
 */
export function sanitizeUpstreamErrorBody(parsed: unknown): Record<string, unknown> {
  // 返す本文の error 部分 (まずは自前の定型文だけ)
  const error: Record<string, unknown> = { message: API_MESSAGES.upstreamRejected };
  // 上流の本文を連想配列として読む (読めなければ定型文だけを返す)
  const root = asRecord(parsed);
  // 上流の error オブジェクト (OpenAI / Anthropic はどちらもここへ詳細を入れる)
  const upstreamError = root === null ? null : asRecord(root.error);
  // 許可リストの項目だけを写す
  if (upstreamError !== null) {
    for (const field of SAFE_ERROR_FIELDS) {
      // 識別子として通してよい値のときだけ載せる
      const value = safeIdentifier(upstreamError[field]);
      if (value !== undefined) error[field] = value;
    }
  }
  // Anthropic は最上位にも type (常に 'error') を置くので、識別子として読めれば保つ
  const topLevelType = root === null ? undefined : safeIdentifier(root.type);
  // 組み直した本文 (上流の他の項目・request_id・自由記述はすべて落ちる)
  return topLevelType === undefined ? { error } : { type: topLevelType, error };
}
