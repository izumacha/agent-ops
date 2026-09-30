// 1 往復だけの LLM 呼び出しについて、**プロバイダごとの違いをここだけに閉じる**。
// 中継 (プロキシ) はクライアントの本文をそのまま渡すので本文を組み立てないが、Step3 の評価は
// こちら側が本文を作って送るため、その組み立てと応答テキストの取り出しが要る。
// トークン数の読み取りで同じことをしているのが src/lib/proxy/usage.ts で、役割分担も同じ
import { Provider } from '@/domain/types';

/** 1 往復の呼び出しに必要な材料 */
export interface LlmCall {
  // どのプロバイダへ送るか
  provider: Provider;
  // 使うモデル名
  model: string;
  // 役割の指示 (省略可)
  system?: string;
  // 本文
  user: string;
  // 生成させる上限トークン数
  maxTokens: number;
}

/**
 * 送る本文 (JSON 文字列) を組み立てる。
 * **OpenAI は `max_completion_tokens` を使う** — 新しいモデル (gpt-5 系) は旧来の `max_tokens` を
 * 受け付けず 400 になるため。Anthropic は `max_tokens` が必須
 */
export function buildRequestBody(call: LlmCall): string {
  // Anthropic Messages API の形
  if (call.provider === Provider.anthropic) {
    return JSON.stringify({
      model: call.model,
      max_tokens: call.maxTokens,
      // 役割の指示は専用の項目で渡す (省略時は項目ごと出さない)
      ...(call.system === undefined ? {} : { system: call.system }),
      messages: [{ role: 'user', content: call.user }],
    });
  }
  // OpenAI Chat Completions API の形 (役割の指示も messages の 1 要素として渡す)
  return JSON.stringify({
    model: call.model,
    max_completion_tokens: call.maxTokens,
    messages: [
      ...(call.system === undefined ? [] : [{ role: 'system', content: call.system }]),
      { role: 'user', content: call.user },
    ],
  });
}

// Anthropic の応答から本文を取り出す (content 配列のうち type が text のものを連結する)
function readAnthropicText(payload: Record<string, unknown>): string | null {
  // content が配列でなければ読めない
  const content = payload.content;
  if (!Array.isArray(content)) return null;
  // text 要素だけを集める
  const parts: string[] = [];
  for (const block of content) {
    // オブジェクトでなければ飛ばす
    if (typeof block !== 'object' || block === null) continue;
    // type が text で、text が文字列のものだけを使う
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type === 'text' && typeof typed.text === 'string') parts.push(typed.text);
  }
  // 1 つも無ければ読めなかった扱い (空文字を返すと「空の応答」と区別が付かない)
  if (parts.length === 0) return null;
  // 連結して返す
  return parts.join('');
}

// OpenAI の応答から本文を取り出す (choices[0].message.content)
function readOpenAiText(payload: Record<string, unknown>): string | null {
  // choices が配列でなければ読めない
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  // 先頭の選択肢
  const first = choices[0];
  if (typeof first !== 'object' || first === null) return null;
  // message.content が文字列であること
  const message = (first as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as { content?: unknown }).content;
  // 文字列でなければ読めなかった扱い
  return typeof content === 'string' ? content : null;
}

/**
 * 上流の応答 (解析済み JSON) から本文テキストを取り出す。読めなければ null。
 * **勝手に空文字へ倒さない** — 「応答が空だった」と「形が読めなかった」を混ぜると、
 * 採点が空文字に対して行われて 0 点の行が静かに積まれる
 */
export function readResponseText(provider: Provider, payload: unknown): string | null {
  // オブジェクトでなければ読めない
  if (typeof payload !== 'object' || payload === null) return null;
  // プロバイダごとの取り出し方
  return provider === Provider.anthropic
    ? readAnthropicText(payload as Record<string, unknown>)
    : readOpenAiText(payload as Record<string, unknown>);
}
