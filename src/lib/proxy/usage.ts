// 上流の応答からトークン数を読み取る。プロバイダごとに項目名が違うので、**その違いはここだけに閉じる**。
// 読めなかったときは null を返し、呼び出し側が「計測できなかった呼び出し」として扱う
// (勝手に 0 とみなすと、料金 0 の行が正常な記録に紛れて請求の根拠が崩れる)。
import { Provider } from '@/domain/types';
import { USAGE_TOKENS_MAX } from '@/lib/constants';

// 読み取ったトークン数
export interface UpstreamUsage {
  // 入力トークン数
  inputTokens: number;
  // 出力トークン数
  outputTokens: number;
}

// プロバイダごとの項目名 (上流の JSON の usage オブジェクトの中の綴り)
const USAGE_FIELDS: Readonly<Record<Provider, { input: string; output: string }>> = {
  // Anthropic Messages API
  [Provider.anthropic]: { input: 'input_tokens', output: 'output_tokens' },
  // OpenAI Chat Completions API
  [Provider.openai]: { input: 'prompt_tokens', output: 'completion_tokens' },
};

// 値がトークン数として使える数値か (負・小数・NaN・大きすぎる値は使わない)
function toTokenCount(value: unknown): number | null {
  // 0 以上の安全な整数だけを受け付ける (上流の申告値をそのまま信じない)
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  // **保存できる範囲まで確かめる。** 安全な整数 (2^53-1) まで通していたときは、
  // `UsageEvent` の `Int` 列 (2^31-1) に入らない値が記録時に P2020 で落ち、`recordUsage` が
  // それを飲むので**利用イベントが 1 行も残らなかった** (実測)。中継は成功しているので
  // 上流の課金は発生しており、ADR-0007 決定 5 が避けたい「課金されたのに台帳に無い」状態になる。
  // ここで弾けば「トークン数を読めなかった」経路へ合流し、料金 0 の行が必ず 1 行残る
  if (value > USAGE_TOKENS_MAX) return null;
  // 使える値
  return value;
}

/** 上流の応答 (解析済み JSON) からトークン数を読む。読めなければ null */
export function readUpstreamUsage(provider: Provider, payload: unknown): UpstreamUsage | null {
  // オブジェクトでなければ読めない
  if (typeof payload !== 'object' || payload === null) return null;
  // usage オブジェクトを取り出す
  const usage = (payload as { usage?: unknown }).usage;
  // usage がオブジェクトでなければ読めない
  if (typeof usage !== 'object' || usage === null) return null;
  // そのプロバイダでの項目名
  const fields = USAGE_FIELDS[provider];
  // 入力・出力それぞれを数値として読む
  const inputTokens = toTokenCount((usage as Record<string, unknown>)[fields.input]);
  const outputTokens = toTokenCount((usage as Record<string, unknown>)[fields.output]);
  // どちらかが読めなければ計測できなかった扱い
  if (inputTokens === null || outputTokens === null) return null;
  // 読み取れたトークン数
  return { inputTokens, outputTokens };
}
