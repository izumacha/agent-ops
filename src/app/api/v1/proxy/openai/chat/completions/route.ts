// POST /api/v1/proxy/openai/chat/completions — OpenAI Chat Completions API への中継 (Step2)
import { Provider } from '@/domain/types';
import { proxyRoute } from '../../../proxy-route';

// 中継の本体は共通のファクトリが持つ (包んだハンドラを再エクスポートするだけ)
export const POST = proxyRoute(Provider.openai);
