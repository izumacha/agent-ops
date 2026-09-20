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
// **残る境界（形では塞げない。ADR-0007 決定 7 に同じことを書いてある）**:
//   - `type` / `code` / `param` はいずれもベンダーの語彙なので、`billing_hard_limit_reached` の
//     ように「共有している上流アカウントの状態」をカテゴリとして示す値は残る。
//   - 短い語を繋いだ文も総長の上限までは通る。`param` はドットを許すので
//     `org_ACME_Corp.tier_enterprise.balance_zero`（42 文字）が通り、`type` / `code` は
//     `_` 区切りだけなので同じ文字列は落ちる。綴りと長さを締めるほど実在のベンダー値まで
//     落ちるので、ここが実用的な下限。
//     **「空白が無いから散文は入らない」とは言えない** — 空白は `_` や `.` で置き換えられる（実測）。
// 完全に塞ぐには「既知の安全なコードだけの閉じた語彙」にするしかないが、ベンダーが値を増やす
// たびに診断が黙って消える（別の壊れ方）ので採らない。
import { API_MESSAGES } from '@/lib/constants';

// 通してよい項目と、その項目に許す綴り。**項目ごとに形が違う**ので 1 本の正規表現にまとめない —
// まとめると、param のために必要なドットと角括弧が type / code にも効いてしまい、
// 区切り文字で単語を繋いだ文（`billing.org-ACME_Corp.tier-enterprise` 等）が素通りする（実測）。
//   type / code … ベンダーの分類語彙。snake_case か PascalCase で、区切りは `_` だけ
//   param       … 問題のあった入力項目。`messages[0].content` のような JSON パスを取る
//
// **総長の先読みが要る。** 綴りだけを絞って 1 語ずつの長さで区切ると、語数ぶん掛け算になって
// かえって**運べる文字数が増える**（項目別に分けた最初の版は 1 応答あたり 256 → 387 文字に増え、
// 99 文字の散文がそのまま中継された。実測）。先頭に `(?=.{1,N}$)` を置いて総長で頭を押さえる。
// いまの上限は type / code が 40 文字・param が 48 文字で、**1 応答あたり 168 文字**。
// 実在のベンダー値（Anthropic / OpenAI / Azure OpenAI / Bedrock の 33 件）はすべて通る。
const SAFE_CODE_PATTERN = /^(?=.{1,40}$)[A-Za-z][A-Za-z0-9]{0,31}(?:_[A-Za-z0-9]{1,23}){0,3}$/;
const SAFE_PARAM_PATTERN =
  /^(?=.{1,48}$)[A-Za-z_][A-Za-z0-9_]{0,23}(?:\[[0-9]{1,4}\]|\.[A-Za-z_][A-Za-z0-9_]{0,23}){0,5}$/;

// 項目名 → その項目に許す綴り (許可リストはこの表が唯一の定義)
const SAFE_ERROR_FIELDS: Readonly<Record<'type' | 'code' | 'param', RegExp>> = {
  // エラーの種別 (invalid_request_error / not_found_error など)
  type: SAFE_CODE_PATTERN,
  // 細かい理由コード (context_length_exceeded など)
  code: SAFE_CODE_PATTERN,
  // 問題のあった入力項目の名前 (messages[0].content など)
  param: SAFE_PARAM_PATTERN,
};

// オブジェクト (連想配列) として読めるかどうか
function asRecord(value: unknown): Record<string, unknown> | null {
  // null でないオブジェクトで、配列でないものだけ
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  // 連想配列として扱う
  return value as Record<string, unknown>;
}

// その項目に許した綴りに収まる文字列だけを取り出す (それ以外は undefined)
function safeIdentifier(value: unknown, pattern: RegExp): string | undefined {
  // 文字列でなければ通さない
  if (typeof value !== 'string') return undefined;
  // 綴りに収まるものだけを通す (fail-closed)
  return pattern.test(value) ? value : undefined;
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
  // 許可リストの項目だけを、それぞれの綴りで確かめてから写す
  if (upstreamError !== null) {
    for (const [field, pattern] of Object.entries(SAFE_ERROR_FIELDS)) {
      // その項目に許した綴りに収まる値のときだけ載せる
      const value = safeIdentifier(upstreamError[field], pattern);
      if (value !== undefined) error[field] = value;
    }
  }
  // Anthropic は最上位にも type (常に 'error') を置くので、分類語彙として読めれば保つ
  const topLevelType = root === null ? undefined : safeIdentifier(root.type, SAFE_CODE_PATTERN);
  // 組み直した本文 (上流の他の項目・request_id・自由記述はすべて落ちる)
  return topLevelType === undefined ? { error } : { type: topLevelType, error };
}
