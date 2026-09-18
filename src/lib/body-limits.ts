// リクエスト本文のサイズ上限。**`next.config.ts` から import されるので、このファイルは定数だけを持ち、
// import はしない（相対 import すら持たない）** — Next.js の config transpile は `next.config.ts` 自身の
// import しか `paths` を書き換えないため、連鎖の中に `@/...` が残ると `npm run build` だけが落ちる
// （lint も typecheck もユニットテストも通ってしまう）。`src/lib/constants.ts` は `@/domain/...` を
// import しているので、値をそちらに置いたままにはできない。

// JSON 本文の上限 (バイト)。Step1 の入力は短い文字列だけなので小さく保つ (§9 リクエストサイズ上限)。
// ハンドラ側の 413 判定 (`src/lib/api/body.ts`) が使う値で、`src/lib/constants.ts` が再公開する
export const JSON_BODY_MAX_BYTES = 64 * 1024;

// 入口（proxy）でバッファしてよい本文の余裕。**上限ちょうどにしない** — proxy を置くと Next.js は
// 非 GET の本文を入口で読み、上限を超えた分を**エラーにせず切り詰めて**ハンドラへ渡す。入口の上限を
// `JSON_BODY_MAX_BYTES` ちょうどにすると、上限超過の要求が「ちょうど上限」に化けて 413 を返せなくなる
const ENTRY_BODY_MARGIN_BYTES = 64 * 1024;

// 入口でバッファする本文の上限 (`next.config.ts` の `experimental.proxyClientMaxBodySize`)。
// **既定 (10 MiB) のままにしない** — 入口のバッファは認証より前に走るので、未認証の相手が
// 1 接続あたり 10 MiB のヒープを握れる（実測: 50 接続 × 5 MiB 先行送信で RSS +160 MB。
// この値まで絞ると +48 MB まで下がり、proxy を置かない場合とほぼ同じになる）。
// **保持時間はこの設定では直らない**（本文を送り終えるまで応答が出ない）ので、本文のタイムアウトと
// サイズは前段のリバースプロキシでも落とす前提（ADR-0005 の宿題）
export const ENTRY_MAX_BODY_BYTES = JSON_BODY_MAX_BYTES + ENTRY_BODY_MARGIN_BYTES;
