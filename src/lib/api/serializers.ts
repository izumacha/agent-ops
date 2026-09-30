// データ層のレコードを OpenAPI の DTO へ写す (Date → ISO 文字列、BigInt → 文字列)。
// 秘密 (tokenHash / keyHash) はここで落とし、DTO に載せない
import type {
  AgentRecord,
  ApiKeyRecord,
  DailyUsageTotal,
  EvaluationCaseRecord,
  EvaluationResultRecord,
  EvaluationRunRecord,
  EvaluationSetRecord,
  Page,
  TenantRecord,
  UserRecord,
  UserTokenRecord,
} from '@/data';
import type {
  AgentDto,
  ApiKeyDto,
  DailyUsageDto,
  EvaluationCaseDto,
  EvaluationRegressionDto,
  EvaluationResultDto,
  EvaluationRunDto,
  EvaluationSetDto,
  TenantDto,
  UserDto,
  UserTokenDto,
} from '@/lib/api-types';

// 一覧の応答 (OpenAPI の *List スキーマ共通の形: items と、次ページがあるときだけ nextCursor)
export interface ListDto<T> {
  items: T[];
  nextCursor?: string;
}

// Page をそのまま一覧 DTO へ写す (行ごとの変換関数を受け取る。6 つの一覧ルートが同じ形を持つので 1 か所にする)
export function toListDto<R, D>(page: Page<R>, mapRow: (row: R) => D): ListDto<D> {
  // 行を変換し、次ページがあるときだけ nextCursor を載せる (undefined のキーは JSON に出ない)
  return {
    items: page.items.map(mapRow),
    ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
  };
}

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

// 日次集計の 1 日分 (料金は BigInt なので文字列で運ぶ。金額の扱いは docs/spec.md §3 と同じ)
export function toDailyUsageDto(row: DailyUsageTotal): DailyUsageDto {
  // 公開するプロパティだけを写す
  return {
    day: row.day,
    requests: row.requests,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costMicroUsd: row.costMicroUsd.toString(),
  };
}

// 評価セット (一覧・詳細の共通部分)
export function toEvaluationSetDto(row: EvaluationSetRecord): EvaluationSetDto {
  // 公開するプロパティだけを写す
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
  };
}

// 評価ケース (setId は親に現れるので DTO には載せない)
export function toEvaluationCaseDto(row: EvaluationCaseRecord): EvaluationCaseDto {
  // 並び順と中身だけを写す
  return { id: row.id, position: row.position, input: row.input, expected: row.expected };
}

// 評価実行 (一覧・詳細の共通部分)
export function toEvaluationRunDto(row: EvaluationRunRecord): EvaluationRunDto {
  // 公開するプロパティだけを写す
  return {
    id: row.id,
    tenantId: row.tenantId,
    agentId: row.agentId,
    setId: row.setId,
    status: row.status,
    accuracy: row.accuracy,
    safety: row.safety,
    deviation: row.deviation,
    scoredCases: row.scoredCases,
    excludedCases: row.excludedCases,
    judgeProvider: row.judgeProvider,
    judgeModel: row.judgeModel,
    createdAt: row.createdAt.toISOString(),
  };
}

// 採点結果 (どのケースがどう採点・除外されたか)
export function toEvaluationResultDto(row: EvaluationResultRecord): EvaluationResultDto {
  // id / runId / setId は親に現れるので載せない
  return {
    caseId: row.caseId,
    accuracy: row.accuracy,
    safety: row.safety,
    deviation: row.deviation,
    excludedReason: row.excludedReason,
  };
}

// 2 つの値の差 (今回 − 前回)。**片方でも平均が無ければ差は null** —
// 「測れなかった」実行との差を 0 や現在値として出すと、回帰の有無を読み違える
function scoreDelta(current: number | null, previous: number | null): number | null {
  // どちらかが無ければ差は出せない
  if (current === null || previous === null) return null;
  // 今回から前回を引く
  return current - previous;
}

// 直前の実行との差 (回帰比較)
export function toEvaluationRegressionDto(
  current: EvaluationRunRecord,
  previous: EvaluationRunRecord,
): EvaluationRegressionDto {
  // 3 項目の差をそれぞれ求める
  return {
    previousRunId: previous.id,
    accuracyDelta: scoreDelta(current.accuracy, previous.accuracy),
    safetyDelta: scoreDelta(current.safety, previous.safety),
    deviationDelta: scoreDelta(current.deviation, previous.deviation),
  };
}
