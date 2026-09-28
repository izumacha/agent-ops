// OpenAPI 定義 (openapi/openapi.yaml) から `npm run gen` で生成した型を、アプリ側の名前で再公開する。
// ルートハンドラ・クライアントはここから型を取り、生成物のパスを直接書かない (生成先を変えても影響をここに閉じ込める)。
import type { components, paths } from '@/generated/openapi';

// API のパス一覧 (キーがパス文字列)
export type ApiPaths = paths;
// スキーマ定義 (components.schemas) の型
export type ApiSchemas = components['schemas'];
// 代表的な DTO の別名
export type TenantDto = ApiSchemas['Tenant'];
export type AgentDto = ApiSchemas['Agent'];
export type ApiKeyDto = ApiSchemas['ApiKey'];
export type UserDto = ApiSchemas['User'];
export type UserTokenDto = ApiSchemas['UserToken'];
export type ApiErrorDto = ApiSchemas['Error'];
export type HealthDto = ApiSchemas['Health'];
export type DailyUsageDto = ApiSchemas['DailyUsage'];
