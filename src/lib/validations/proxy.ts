// プロキシが中継する本文の検証。**ここだけ z.strictObject を使わない** —
// 本文はベンダー (Anthropic / OpenAI) のペイロードそのもので、項目はベンダー側の都合で増える。
// 未知キーを拒否すると、新しいパラメータを使いたいだけで中継が止まる。
// 代わりに「計測に必要な最小限の封筒」だけを確かめ、残りはそのまま上流へ渡す (ADR-0007)
import { z } from './zod';
import { shortText } from './common';
import { API_MESSAGES } from '@/lib/constants';

// 中継する本文の最小限の形
export const proxyRequestSchema = z.looseObject({
  // どのモデルを使うか (料金表を引く鍵。省略された呼び出しは計測できないので拒否する)
  model: shortText,
  // ストリーミングは Step2 の範囲外。**省略か false だけを許す** (true は 422 で明示的に断る。
  // 黙って false にして中継すると、利用者が期待した形と違う応答が返る)
  stream: z.literal(false, { error: API_MESSAGES.streamingNotSupported }).optional(),
});

// 検証済みの本文の型 (model 以外の項目も保持する)
export type ProxyRequestBody = z.infer<typeof proxyRequestSchema>;
