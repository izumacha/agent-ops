// バイト列のストリームを「上限まで」読むための共通処理。
//
// `Response.text()` / `Request.text()` は**全量をメモリへ載せてからしか大きさが分からない**ので、
// 上限を効かせたい経路はストリームを読みながら数える必要がある。同じ読み方を
// リクエスト本文 (src/lib/api/body.ts) と上流の応答 (src/lib/proxy/upstream.ts) の 2 か所が要るが、
// **HTTP の意味づけは両者で違う** (前者の超過は 413、後者の超過は 502) ので、
// ここでは「読めたか・大きすぎたか・UTF-8 として壊れているか」だけを返し、
// どの HTTP エラーへ写すかは呼び出し側に任せる。

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
 */
export async function readStreamWithinByteLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<StreamReadResult> {
  // 本文が無ければ空文字 (呼び出し側が「空」として扱う)
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
      // 上限を超えたら、残りを読まずにその場で終える (これ以上メモリを積まない)。
      // reader.cancel() は呼ばない — 呼び出し側 (リクエスト本文) では下層のストリームごと
      // 破棄されて応答が届く前に接続が切れるため。読むのをやめれば残りはランタイムが捨てる
      if (total > maxBytes) return { ok: false, reason: 'too_large' };
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
