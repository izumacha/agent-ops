// 利用イベント (プロキシが中継した LLM 呼び出し 1 回 = 1 行) の Port (契約)。
// 記録も集計も必ずテナントで絞る (ADR-0002)
import type { Provider } from '@/domain/types';
import type { UsageEventRecord } from './types';

// 記録の入力 (料金はアダプタで計算せず、呼び出し側が確定させた値を渡す。
// 単価の解釈が API 層とデータ層の 2 か所に散らないようにするため)
export interface RecordUsageEventInput {
  tenantId: string;
  // 呼び出したエージェント (テナント共通キーでは記録できないので必須)
  agentId: string;
  provider: Provider;
  // 実際に使ったモデル名
  model: string;
  inputTokens: number;
  outputTokens: number;
  // 料金 (マイクロ USD)
  costMicroUsd: bigint;
  // 上流の応答までにかかった時間 (ミリ秒)
  latencyMs: number;
  // 上流の HTTP ステータス (失敗も記録するので 2xx とは限らない)
  statusCode: number;
}

// 日次集計の入力 (期間は半開区間。組み立ての規則は src/domain/usage-window.ts)
export interface DailyUsageQuery {
  // 期間の開始 (含む)
  start: Date;
  // 期間の終了 (含まない)
  endExclusive: Date;
  // エージェントで絞る (指定が無ければテナント全体)
  agentId?: string;
}

// 日次集計の 1 日分
export interface DailyUsageTotal {
  // UTC の日 ('YYYY-MM-DD')
  day: string;
  // その日の呼び出し回数
  requests: number;
  // 入力トークンの合計
  inputTokens: number;
  // 出力トークンの合計
  outputTokens: number;
  // 料金の合計 (マイクロ USD)
  costMicroUsd: bigint;
}

// 利用イベント Port
export interface UsageEventsPort {
  // 1 回の呼び出しを記録する (エージェントが同テナントに無ければ null)
  record(input: RecordUsageEventInput): Promise<UsageEventRecord | null>;
  // 期間内を UTC の日ごとに集計する (日の昇順。イベントが無い日は行が出ない)
  dailyTotals(tenantId: string, query: DailyUsageQuery): Promise<DailyUsageTotal[]>;
}
