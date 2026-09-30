// ドメイン層が使う enum の正準 (canonical) な定義。
// Prisma の生成物を値 import すると、純粋ロジック (rbac.ts) や UI 定数まで Prisma の実行時コード (数 MB) を
// 引き込み、`npm run db:generate` 無しではユニットテストすら動かなくなる。そこで enum は
// ここに `as const` で定義し、Prisma 側の enum と一致することは tests/domain-enums.test.ts が固定する。
// (値は prisma/schema.prisma の enum と同じ文字列。Prisma の enum 型は文字列リテラルの合併型なので、
//  そのまま Prisma のクエリ引数に渡せる)

// テナントの契約プラン
export const Plan = { free: 'free', pro: 'pro', enterprise: 'enterprise' } as const;
// Plan の値の型 ('free' | 'pro' | 'enterprise')
export type Plan = (typeof Plan)[keyof typeof Plan];

// ユーザーの役割 (RBAC)
export const Role = { viewer: 'viewer', operator: 'operator', admin: 'admin' } as const;
// Role の値の型
export type Role = (typeof Role)[keyof typeof Role];

// エージェントの稼働状態
export const AgentStatus = {
  active: 'active',
  stopped: 'stopped',
  suspended: 'suspended',
} as const;
// AgentStatus の値の型
export type AgentStatus = (typeof AgentStatus)[keyof typeof AgentStatus];

// LLM プロバイダ
export const Provider = { anthropic: 'anthropic', openai: 'openai' } as const;
// Provider の値の型
export type Provider = (typeof Provider)[keyof typeof Provider];

// ガードレールのしきい値ルールの種類
export const RuleKind = { cost: 'cost', quality: 'quality', error_rate: 'error_rate' } as const;
// RuleKind の値の型
export type RuleKind = (typeof RuleKind)[keyof typeof RuleKind];

// しきい値に達したときの動作
export const RuleAction = { notify: 'notify', stop: 'stop' } as const;
// RuleAction の値の型
export type RuleAction = (typeof RuleAction)[keyof typeof RuleAction];

// インシデントの状態
export const IncidentStatus = { open: 'open', resolved: 'resolved' } as const;
// IncidentStatus の値の型
export type IncidentStatus = (typeof IncidentStatus)[keyof typeof IncidentStatus];

// 評価実行の結果状態 (Step3)
export const EvaluationRunStatus = { completed: 'completed', failed: 'failed' } as const;
// EvaluationRunStatus の値の型
export type EvaluationRunStatus = (typeof EvaluationRunStatus)[keyof typeof EvaluationRunStatus];

// 採点をケース単位で除外した理由 (Step3)。**「不正出力の除外」の正本はこの表**で、
// ゲート (scripts/gate-step3.mjs) はここから期待するテスト名を導く
export const EvaluationExclusionReason = {
  unknown_case_id: 'unknown_case_id', // judge がセットに無いケース ID を返した (幻覚 ID)
  duplicate_case_id: 'duplicate_case_id', // judge が同じケース ID を 2 回返した
  score_out_of_range: 'score_out_of_range', // スコアが 0.0〜1.0 の範囲外
  missing_score: 'missing_score', // スコアの項目が欠けている / 数値でない
  unparsable_output: 'unparsable_output', // judge の応答を JSON として解釈できない
  judge_unavailable: 'judge_unavailable', // judge の呼び出しが失敗した (時間切れ・5xx・設定不足)
  agent_unavailable: 'agent_unavailable', // 評価対象エージェントの応答を得られなかった
} as const;
// EvaluationExclusionReason の値の型
export type EvaluationExclusionReason =
  (typeof EvaluationExclusionReason)[keyof typeof EvaluationExclusionReason];
