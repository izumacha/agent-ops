// バイト列のストリームを上限まで読む共有処理 (src/lib/stream-bytes.ts)。
// リクエスト本文 (413) と上流の応答 (502) の**両方**が通るので、HTTP から切り離してここで固定する
import { describe, expect, it, vi } from 'vitest';
import { readStreamWithinByteLimit } from '@/lib/stream-bytes';

// バイト列を 1 かたまりずつ流すストリームを作る
function streamOf(chunks: Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  // 渡されたかたまりを順に流して閉じる
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // すべて流す
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
    cancel() {
      // 解放されたことを呼び出し側へ伝える
      onCancel?.();
    },
  });
}

// 文字列を UTF-8 のバイト列にする
function bytes(text: string): Uint8Array {
  // TextEncoder は常に UTF-8
  return new TextEncoder().encode(text);
}

describe('上限つきのストリーム読み取り', () => {
  it('本文が null なら空文字 (getReader で落ちない)', async () => {
    // Request.body / Response.body はどちらも本文が無いとき null を返す
    expect(await readStreamWithinByteLimit(null, 10)).toEqual({ ok: true, text: '' });
  });

  it('上限ちょうどまでは読める', async () => {
    // 5 バイトちょうど
    const result = await readStreamWithinByteLimit(streamOf([bytes('12345')]), 5);
    // 読み切れる
    expect(result).toEqual({ ok: true, text: '12345' });
  });

  it('上限を 1 バイト超えたら打ち切る', async () => {
    // 6 バイト目で超える
    const result = await readStreamWithinByteLimit(streamOf([bytes('123456')]), 5);
    // 大きすぎるとして返る
    expect(result).toEqual({ ok: false, reason: 'too_large' });
  });

  it('cancelOnOverflow を渡すと下層のストリームを解放する (上流の応答側の事情)', async () => {
    // 解放しないと応答ボディが未消費のまま残り、ソケットと fd がタイムアウトまで解放されない。
    // **まだ終わっていないストリーム**で見る — 閉じ終わった後の cancel は何もしないので、
    // 上で使った「全部流してから閉じる」形だと解放の有無を観測できない
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        // 止めるまで流し続ける (実際の上流の応答と同じ形)
        controller.enqueue(bytes('1234'));
      },
      cancel() {
        // 解放されたことを記録する
        cancelled = true;
      },
    });
    // 上限を超えるまで読んで打ち切る
    await readStreamWithinByteLimit(endless, 5, { cancelOnOverflow: true });
    // 解放する
    expect(cancelled).toBe(true);
  });

  it('既定では終わっていないストリームも解放しない', async () => {
    // 上の対になる検査 (既定の側も同じ条件で見ないと、差が出ているのか観測できていないのか分からない)
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        // 止めるまで流し続ける
        controller.enqueue(bytes('1234'));
      },
      cancel() {
        // 解放されたことを記録する
        cancelled = true;
      },
    });
    // 上限を超えるまで読んで打ち切る (オプションは渡さない)
    await readStreamWithinByteLimit(endless, 5);
    // 解放しない
    expect(cancelled).toBe(false);
  });

  it('解放に失敗してもログだけ残して結果は変えない', async () => {
    // このオプションの目的が fd の滞留を防ぐことなので、解放の失敗は運用上いちばん知りたい事象。
    // 握り潰さずログに残す (§6)。ただし結果 (too_large) は変えない
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // cancel が失敗するストリーム
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        // 止めるまで流し続ける
        controller.enqueue(bytes('1234'));
      },
      cancel() {
        // 解放に失敗する
        throw new Error('cancel failed');
      },
    });
    // 上限を超えるまで読んで打ち切る
    const result = await readStreamWithinByteLimit(failing, 5, { cancelOnOverflow: true });
    // 結果は変わらない
    expect(result).toEqual({ ok: false, reason: 'too_large' });
    // 失敗はログに残る
    expect(logged.mock.calls.filter((args) => String(args[0]).includes('解放に失敗'))).toHaveLength(
      1,
    );
    // 差し替えを戻す
    logged.mockRestore();
  });

  it('UTF-8 として壊れたバイト列は置換せずに失敗として返す', async () => {
    // U+FFFD へ黙って置換すると、送り主の意図と違う文字列がそのまま保存・中継される
    const result = await readStreamWithinByteLimit(streamOf([new Uint8Array([0xff])]), 10);
    // 壊れたバイト列として返る
    expect(result).toEqual({ ok: false, reason: 'invalid_utf8' });
  });

  it('読み取りそのものの失敗は投げたまま上げる (切断と障害を呼び出し側が分けられるように)', async () => {
    // 読み取り中に失敗するストリーム
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        // 読もうとした時点で失敗させる
        controller.error(new Error('boom'));
      },
    });
    // 結果ではなく例外として上がる
    await expect(readStreamWithinByteLimit(failing, 10)).rejects.toThrow('boom');
  });
});
