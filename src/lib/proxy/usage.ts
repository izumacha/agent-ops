// 上流の応答からトークン数を読み取る。プロバイダごとに項目名が違うので、**その違いはここだけに閉じる**。
// 読めなかったときは null を返し、呼び出し側が「計測できなかった呼び出し」として扱う
// (勝手に 0 とみなすと、料金 0 の行が正常な記録に紛れて請求の根拠が崩れる)。
import { Provider } from '@/domain/types';

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

// 値がトークン数として使える数値か (負・小数・NaN は使わない)
function toTokenCount(value: unknown): number | null {
  // 0 以上の安全な整数だけを受け付ける (上流の申告値をそのまま信じない)
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
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
