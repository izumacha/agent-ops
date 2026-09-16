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
