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
import { API_MESSAGES } from '@/lib/constants';

// 通してよい項目の名前。いずれも機械可読な識別子で、アカウントの状態を語らない:
//   type  … エラーの種別 (invalid_request_error / not_found_error など)
//   code  … 細かい理由コード (context_length_exceeded など)
//   param … 問題のあった入力項目の名前 (messages / max_tokens など)
const SAFE_ERROR_FIELDS = ['type', 'code', 'param'] as const;

// 値が「そのまま返してよい識別子」か。文字列で、常識的な長さに収まるものだけを通す
// (長い文字列は自由記述が別名で入ってくる経路になる)
const SAFE_FIELD_MAX_LENGTH = 100;

// オブジェクト (連想配列) として読めるかどうか
function asRecord(value: unknown): Record<string, unknown> | null {
  // null でないオブジェクトで、配列でないものだけ
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  // 連想配列として扱う
  return value as Record<string, unknown>;
}

// 識別子として通してよい文字列だけを取り出す (それ以外は undefined)
function safeIdentifier(value: unknown): string | undefined {
  // 文字列で、空でなく、長すぎないもの
  if (typeof value !== 'string' || value === '' || value.length > SAFE_FIELD_MAX_LENGTH) {
    return undefined;
  }
  // そのまま返してよい
  return value;
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
