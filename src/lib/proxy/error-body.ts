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
//     落ちるので、ここが実用的な下限。**`param` の語数は縛れていない**（下の (2) を参照）。
//     1 応答で運べるのは `type` 40 ＋ `error.type` 40 ＋ `code` 40 ＋ `param` 48 = 168 文字。
//   - **語数・階層の上限は数字を 1 文字も数えない。** 添字は 4 桁 × 5 階層、トークンの先頭語は
//     桁数が無制限なので、残高・TPM・ティアのような**数値**は総長の枠いっぱいまで運べる
//     （実測: `a[1234][5678][9012][3456][7890]` 31 文字・`Tpm4000Rpm1000Tier3BalanceUsd0` 30 文字・
//     `creditsRemainingUsdCents00000123456789` 38 文字は、いずれも通る）。
//   - **PascalCase に対して語数の上限は一切効かない**（区切りが無いので 1 語と数える）。
//     `param` は `.` を挟めるので、実質 48 文字までの英文が通る
//     （実測: `YourCreditBalanceIsTooLow.GoToPlansAndBilling` 45 文字）。
//     **「空白が無いから散文は入らない」とは言えない** — 空白は `_` や `.` で置き換えられる（実測）。
// 完全に塞ぐには「既知の安全なコードだけの閉じた語彙」にするしかないが、ベンダーが値を増やす
// たびに診断が黙って消える（別の壊れ方）ので採らない。
import { API_MESSAGES } from '@/lib/constants';

// 通してよい項目と、その項目に許す綴り。**項目ごとに形が違う**ので 1 本の正規表現にまとめない —
// まとめると、param のために必要なドットと角括弧が type / code にも効いてしまい、
// 区切り文字で単語を繋いだ文（`billing.org-ACME_Corp.tier-enterprise` 等）が素通りする（実測）。
//   type / code … ベンダーの分類語彙。snake_case か PascalCase で、区切りは `_` だけ
//   param       … 問題のあった入力項目。`messages[0].content` のような JSON パスを取る
// **ただし「トークン 1 つ」の綴りは共有する**（下記）。
//
// **絞りは 2 段いる。**
//   (1) 総長の先読み `(?=.{1,N}$)` … 1 項目で運べる文字数の頭を押さえる。
//       語ごとの長さだけで区切ると語数ぶんの掛け算になり、項目別に分けた最初の版は
//       1 応答あたり 256 → 387 文字に**増えて**いた（99 文字の散文が中継された。実測）。
//   (2) 語数・階層の上限 … 総長だけでは枠内に収まる英文が通ってしまう（実測:
//       `your_credit_balance_is_too_low` 30 文字、`credit.balance.is.too.low.add.funds.now` 39 文字）。
//       **効き方は項目で違う。** `type` / `code` は 1 トークンなので語数 4 がそのまま散文の上限になり、
//       ここでは (2) が主役。一方 `param` は「6 階層 × 各 4 語」まで許すので**総語数は縛れておらず**、
//       (2) が止めるのは「1 つの区切りに詰め込んだ形」だけ —— 上の 30 文字の散文も、
//       **区切りを 1 つ `.` にするだけで通る**（`your_credit_balance.is_too_low` は PASS。実測）。
//       **これ以上締めない理由**: 総語数に上限を置けば上の 30 文字の散文は落とせるが、
//       **塞ぎきれはしない** — 5 語以内でも `ACME.tier_enterprise.balance_zero`（33 文字）や
//       `org_ACME.balance_zero`（21 文字）は通り、組織名・契約ティア・残高状態はそのまま運べる（実測）。
//       そのうえ上限は 5 にするしかなく（6 語の散文を落とすため）、実在の `param` が既に 5 語に
//       達している（`messages[0].content[0].source.media_type` /
//       `tools[0].custom.format.grammar.definition`）。**得るものが小さく、失うものは
//       「ベンダーがパスを 1 段深くした時点で診断が黙って消える」**なので締めない。
//
// **トークンの定義は 1 つにする。** param 用の綴りを別に書いていたとき、あちらの文字クラスは
// `_` を**トークンの内側**に含んでいたため、階層の上限が `_` を 1 つも数えず、
// 上の (2) が param にだけ効かなかった（実測で 30〜48 文字のアンダースコア散文がそのまま中継された）。
// トークンを共有すれば「語数を数える」という規則が両方へ同じように効く。
const IDENTIFIER_TOKEN = String.raw`[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]{1,16}){0,3}`;

// type / code … ベンダーの分類語彙。トークン 1 つで、総長 40 文字まで
const SAFE_CODE_PATTERN = new RegExp(`^(?=.{1,40}$)${IDENTIFIER_TOKEN}$`);
// param … 問題のあった入力項目。トークンを `.` と `[添字]` で 6 つまで繋いだ JSON パスで、総長 48 文字まで
const SAFE_PARAM_PATTERN = new RegExp(
  `^(?=.{1,48}$)${IDENTIFIER_TOKEN}(?:\\[[0-9]{1,4}\\]|\\.${IDENTIFIER_TOKEN}){0,5}$`,
);
// 数値の上限はこれだけで、いずれも tests/proxy-error-body.test.ts が上下両側で固定する:
//   総長 40 / 48・1 トークンの語数 4・階層 6・添字の桁数 4・語の長さ 16（先頭語を除く）。
// **各トークンの先頭語だけ長さを切らない** — 実在の 1 語（Bedrock の
// ProvisionedThroughputExceededException 38 文字）が落ちてしまうため。`param` は `.` で
// トークンを繋ぐので、**2 トークン目以降の先頭語も長さを切らない**（頭を押さえているのは総長だけ。
// 実測: `a.` ＋ `b` 46 個 = 48 文字は通る）。その副作用として、区切りの無い 40 文字のかたまりは通る
// （`AddFundsAtPlansAndBillingBalanceZero` 36 文字のように、**PascalCase なら英文も通る**。実測）。
// 通る実在のベンダー値は tests/proxy-error-body.test.ts が固定する（件数はここに書かない）。

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
