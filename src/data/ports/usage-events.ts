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

// ガードレールの集計窓 (任意の半開区間) の集計入力。**日次集計とは別の形** —
// 日次は「UTC の日ごとに割った複数行」だが、ガードレールは「窓の中の 1 つの合計」が要る
// (窓は 1 分〜7 日の任意の長さで、日境界とは揃わない)
export interface UsageWindowQuery {
  // 期間の開始 (含む)
  start: Date;
  // 期間の終了 (含まない)
  endExclusive: Date;
  // エージェントで絞る (指定が無ければテナント全体)
  agentId?: string;
}

// 窓の中の合計。**エラー率の分母と分子を一緒に返す** — 2 回のクエリに分けると
// その間に入った呼び出しのぶん分母と分子がずれ、`3 / 0` のような測定値が生まれる
// (ガードレールの判定はそれを「測れない」として扱うが、そもそも作らないほうがよい)
export interface UsageWindowTotal {
  // 窓の中の呼び出し回数 (エラー率の分母)
  requests: number;
  // そのうち上流の HTTP ステータスが 400 以上だった回数 (エラー率の分子)
  errorRequests: number;
  // 料金の合計 (マイクロ USD)
  costMicroUsd: bigint;
}

// 利用イベント Port
export interface UsageEventsPort {
  // 1 回の呼び出しを記録する (エージェントが同テナントに無ければ null)
  record(input: RecordUsageEventInput): Promise<UsageEventRecord | null>;
  // 期間内を UTC の日ごとに集計する (日の昇順。イベントが無い日は行が出ない)
  dailyTotals(tenantId: string, query: DailyUsageQuery): Promise<DailyUsageTotal[]>;
  // 任意の半開区間を 1 つの合計にまとめる (ガードレールの判定が使う)
  windowTotals(tenantId: string, query: UsageWindowQuery): Promise<UsageWindowTotal>;
}
