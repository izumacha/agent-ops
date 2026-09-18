// リクエスト本文のサイズ上限。**`next.config.ts` から import されるので、このファイルは定数だけを持ち、
// import はしない（相対 import すら持たない）** — Next.js の config transpile は `next.config.ts` 自身の
// import しか `paths` を書き換えないため、連鎖の中に `@/...` が残ると `npm run build` だけが落ちる
// （lint も typecheck もユニットテストも通ってしまう）。`src/lib/constants.ts` は `@/domain/...` を
// import しているので、値をそちらに置いたままにはできない。

// JSON 本文の上限 (バイト)。Step1 の入力は短い文字列だけなので小さく保つ (§9 リクエストサイズ上限)。
// ハンドラ側の 413 判定 (`src/lib/api/body.ts`) が使う値で、`src/lib/constants.ts` が再公開する
export const JSON_BODY_MAX_BYTES = 64 * 1024;

// Node の HTTP 本文が 1 回の data イベントで運ぶ最大バイト数（ソケットの既定 `highWaterMark`）。
// 入口の余裕はこれ以上にする — Next.js は**上限を跨いだかたまりを丸ごと捨てて**ストリームを閉じるので、
// 余裕がこれ未満だと切り詰め後の長さが `JSON_BODY_MAX_BYTES` **ちょうど**に着地でき、
// `total > maxBytes` が偽になって 413 が出ない。実測では余裕を 1 KiB にした版へ、先頭 64 KiB が
// それ自体で完結した妥当な JSON になる本文を chunked で送ると **201 が返り**、送信者が書いた
// `description` を落とした別の資源が黙って作られた（`ENTRY_MAX_BODY_BYTES` が上限ちょうどのときと
// 同じ壊れ方が、余裕が「1 回の読み取り」に満たないだけでも起きる）
export const MAX_SOCKET_READ_BYTES = 64 * 1024;

// 入口でバッファする本文の上限 (`next.config.ts` の `experimental.proxyClientMaxBodySize`)。
// **既定 (10 MiB) のままにしない** — 入口のバッファは認証より前に走るので、未認証の相手が
// 1 接続あたり 10 MiB のヒープを握れる。**実測値の記録はここだけに置く**（同じ事実を複数の文書へ
// 書き写すと、いずれどれかが古くなる。§6 DRY）: 未認証の POST を数十接続ぶん先行送信したときの
// サーバプロセスの RSS 増は、既定のままだと +200 MB 超、この値まで絞ると +50 MB 未満で、
// proxy を置かない場合（+40 MB 台）とほぼ同じになる。
// **保持時間はこの設定では直らない**（本文を送り終えるまで応答が出ない）ので、本文のタイムアウトと
// サイズは前段のリバースプロキシでも落とす前提（ADR-0005 の宿題）。
// 余裕は「1 回のソケット読み取り」ちょうど。上下どちらへずらしても壊れるので、両方向を
// `tests/proxy.test.ts` が固定する（小さすぎると上の 201、大きすぎると未認証に握らせるヒープが戻る）
export const ENTRY_MAX_BODY_BYTES = JSON_BODY_MAX_BYTES + MAX_SOCKET_READ_BYTES;
