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
// 1 接続あたり 10 MiB のヒープを握れる。
//
// **実測値の記録はここだけに置く**（同じ事実を複数の文書へ書き写すと、いずれどれかが古くなる。§6 DRY）。
// 計測は「未認証の `POST /api/v1/agents` を 50 接続、1 接続あたり 5 MiB を先行送信し、サーバプロセスの
// RSS の増分を見る」形で行った:
//   - 既定 (10 MiB) のまま ………… +160 MB
//   - この値 (128 KiB) まで絞る … +45〜48 MB（proxy を置かない場合の +42 MB とほぼ同じ）
//   - 余白だけを既定相当へ戻す変異 … +201〜244 MB（40〜50 接続。**その変異は lint・typecheck・
//     全テストが緑のままで、テスト件数も変わらなかった** — だから値そのものを検査で固定している）
//
// **保持時間はこの設定では直らない**（本文を送り終えるまで応答が出ない）ので、本文のタイムアウトと
// サイズは前段のリバースプロキシでも落とす前提（ADR-0005 の宿題）。
//
// 余裕の不変条件は「**1 回のソケット読み取り以上、その 2 倍以内**」で、`tests/proxy.test.ts` が
// Node から実測した読み取り単位を基準に両方向を固定する（小さすぎると上の 201、大きすぎると
// 未認証に握らせるヒープが戻る）。いまの値は下端ちょうど（＝ 1 倍）
export const ENTRY_MAX_BODY_BYTES = JSON_BODY_MAX_BYTES + MAX_SOCKET_READ_BYTES;
