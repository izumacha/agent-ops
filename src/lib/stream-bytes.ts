// バイト列のストリームを「上限まで」読むための共通処理。
//
// `Response.text()` / `Request.text()` は**全量をメモリへ載せてからしか大きさが分からない**ので、
// 上限を効かせたい経路はストリームを読みながら数える必要がある。同じ読み方を
// リクエスト本文 (src/lib/api/body.ts) と上流の応答 (src/lib/proxy/upstream.ts) の 2 か所が要るが、
// **HTTP の意味づけは両者で違う** (前者の超過は 413、後者の超過は 502) ので、
// ここでは「読めたか・大きすぎたか・UTF-8 として壊れているか」だけを返し、
// どの HTTP エラーへ写すかは呼び出し側に任せる。

// エラーをログへ落とす形 (経路ごとに書き分けない。src/lib 直下の 1 か所が唯一の定義)
import { describeError } from '@/lib/describe-error';

// 読み取りの結果 (成功なら本文、失敗なら理由)
export type StreamReadResult =
  // 上限内で読み切れた
  | { ok: true; text: string }
  // 上限を超えたので途中で打ち切った
  | { ok: false; reason: 'too_large' }
  // UTF-8 として解釈できないバイト列だった
  | { ok: false; reason: 'invalid_utf8' };

/**
 * ストリームを上限バイトまで読む。超えた時点で残りを読まずに打ち切る。
 * **読み取りそのものの失敗 (切断など) は投げたまま**にする — 切断を「ふつうの結果」に混ぜると、
 * 呼び出し側がクライアントの切断と上流の障害を区別できなくなる。
 * @param stream 読むストリーム (null なら空文字を返す)
 * @param maxBytes 許す最大バイト数 (これを 1 バイトでも超えたら打ち切る)
 * @param options cancelOnOverflow: 上限超過で打ち切るときに下層のストリームも解放するか
 */
export async function readStreamWithinByteLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  options: { cancelOnOverflow?: boolean } = {},
): Promise<StreamReadResult> {
  // 本文が無ければ空文字 (呼び出し側が「空」として扱う)。
  // **undefined は受け付けない** — Request.body / Response.body はどちらも本文が無いとき null を
  // 返すので (Node 22 で実測)、undefined まで通すと「本文が無い」と「項目名を間違えた」が
  // 同じ結果になり、後者が「空＝正常」として静かに通る (§9 fail-closed)
  if (stream === null) return { ok: true, text: '' };
  // ストリームを少しずつ読む
  const reader = stream.getReader();
  // 読んだかたまりと合計バイト数
  const chunks: Uint8Array[] = [];
  let total = 0;
  // 上限を超えたら残りを読まずに打ち切る
  try {
    // 終端まで読む
    for (;;) {
      // 次のかたまり
      const { done, value } = await reader.read();
      // 終端なら抜ける
      if (done) break;
      // 合計を更新する
      total += value.byteLength;
      // 上限を超えたら、残りを読まずにその場で終える (これ以上メモリを積まない)
      if (total > maxBytes) {
        // **下層を解放するかは呼び出し側が決める** — 2 つの経路で事情が正反対なので、
        // 共有ヘルパーの既定に寄せると片方が必ず壊れる:
        //   - リクエスト本文: cancel すると Next.js が下層の IncomingMessage ごと破棄し、
        //     送信済みの 413 が届く前に接続が切れる (クライアントには ECONNRESET に見える)。
        //     読むのをやめれば残りはランタイムが捨てるので、ここでは cancel しない
        //   - 上流の応答: cancel しないと応答ボディが未消費のまま残り、ソケットと fd が
        //     解放されない (実測で 502 を返した 20 秒後もソケットが閉じなかった)
        // 解放そのものが失敗しても結果 (too_large) は変わらないので処理は続けるが、
        // このオプションの目的が fd の滞留を防ぐことなので、失敗は運用上いちばん知りたい事象。
        // 握り潰さずログだけ残す (§6 エラーを握り潰さない)
        if (options.cancelOnOverflow === true) {
          await reader.cancel().catch((error: unknown) => {
            console.error(
              '[stream] 上限超過後のストリーム解放に失敗しました:',
              describeError(error),
            );
          });
        }
        // 打ち切った理由
        return { ok: false, reason: 'too_large' };
      }
      // 上限内なら取っておく
      chunks.push(value);
    }
  } finally {
    // 打ち切り・完了・例外のどれでもストリームを解放する (§8 リソースを確実に解放する)
    reader.releaseLock();
  }
  // UTF-8 として連結する。不正なバイト列は置換 (U+FFFD) せず失敗として返す
  // (黙って置換すると、送り主の意図と違う文字列がそのまま保存・中継される)
  try {
    // fatal: true なので壊れたバイト列は例外になる
    return {
      ok: true,
      text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    };
  } catch {
    // 壊れたバイト列
    return { ok: false, reason: 'invalid_utf8' };
  }
}
