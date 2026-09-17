// データ層のレコードを OpenAPI の DTO へ写す (Date → ISO 文字列、BigInt → 文字列)。
// 秘密 (tokenHash / keyHash) はここで落とし、DTO に載せない
import type { AgentRecord, ApiKeyRecord, TenantRecord, UserRecord, UserTokenRecord } from '@/data';
import type { AgentDto, ApiKeyDto, ApiSchemas, TenantDto, UserDto } from '@/lib/api-types';

// ユーザートークンの DTO (OpenAPI の UserToken スキーマ)
export type UserTokenDto = ApiSchemas['UserToken'];

// Date | null を ISO 文字列 | null にする
function isoOrNull(value: Date | null): string | null {
  // null はそのまま、Date は ISO 8601 文字列
  return value === null ? null : value.toISOString();
}

// テナント
export function toTenantDto(row: TenantRecord): TenantDto {
  // 公開するプロパティだけを写す
  return { id: row.id, name: row.name, plan: row.plan, createdAt: row.createdAt.toISOString() };
}

// ユーザー
export function toUserDto(row: UserRecord): UserDto {
  // 無効化日時も公開する (一覧で有効/無効を見分けるため)
  return {
    id: row.id,
    tenantId: row.tenantId,
    email: row.email,
    name: row.name,
    role: row.role,
    disabledAt: isoOrNull(row.disabledAt),
    createdAt: row.createdAt.toISOString(),
  };
}

// ユーザートークン (ハッシュは載せない)
export function toUserTokenDto(row: UserTokenRecord): UserTokenDto {
  // 表示用の先頭・用途・期限・失効だけ
  return {
    id: row.id,
    userId: row.userId,
    prefix: row.prefix,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: isoOrNull(row.revokedAt),
  };
}

// エージェント (BigInt は文字列で運ぶ)
export function toAgentDto(row: AgentRecord): AgentDto {
  // 予算は BigInt → 10 進文字列 (null はそのまま)
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    description: row.description,
    provider: row.provider,
    model: row.model,
    status: row.status,
    budgetMicroUsd: row.budgetMicroUsd === null ? null : row.budgetMicroUsd.toString(),
    createdAt: row.createdAt.toISOString(),
  };
}

// API キー (ハッシュは載せない)
export function toApiKeyDto(row: ApiKeyRecord): ApiKeyDto {
  // 表示用の先頭・用途・失効だけ
  return {
    id: row.id,
    tenantId: row.tenantId,
    agentId: row.agentId,
    prefix: row.prefix,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    revokedAt: isoOrNull(row.revokedAt),
  };
}
