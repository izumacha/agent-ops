// データ層の Port が扱うレコード型とページネーション型 (Prisma / Next 非依存)。
// API 層と memory / prisma アダプタが共通で使う。Prisma の生成型を使わないのは、
// memory アダプタと API テストが `npm run db:generate` 無しでも動くようにするため
import type { AgentStatus, Plan, Provider, Role } from '@/domain/types';

// カーソルが指す位置 (createdAt, id)。符号化・復号の規則は src/data/page.ts
export interface CursorKey {
  createdAt: Date;
  id: string;
}

// 一覧取得の入力 (件数と続きの位置)
export interface PageQuery {
  // 取得件数 (呼び出し側で 1〜最大値に正規化済み)
  limit: number;
  // 前回応答の nextCursor を API 層で復号した位置 (無ければ先頭から)。復号は API 層で 1 回だけ行う
  cursor?: CursorKey;
}

// 一覧取得の出力 (次ページがあるときだけ nextCursor を持つ)
export interface Page<T> {
  // 取得した行
  items: T[];
  // 次ページの先頭を指すカーソル (最終行の位置 (createdAt, id) を符号化した不透明な値。src/data/page.ts。次ページが無ければ undefined)
  nextCursor?: string;
}

// テナント
export interface TenantRecord {
  id: string;
  name: string;
  plan: Plan;
  createdAt: Date;
  updatedAt: Date;
}

// ユーザー
export interface UserRecord {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: Role;
  // 無効化日時 (null なら有効)
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ユーザーのログイントークン (ハッシュのみ。平文は持たない)
export interface UserTokenRecord {
  id: string;
  tenantId: string;
  userId: string;
  prefix: string;
  tokenHash: string;
  name: string;
  createdAt: Date;
  expiresAt: Date;
  // 失効日時 (null なら有効)
  revokedAt: Date | null;
}

// エージェント
export interface AgentRecord {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  provider: Provider;
  model: string;
  status: AgentStatus;
  // 月次予算 (マイクロ USD)。未設定は null
  budgetMicroUsd: bigint | null;
  createdAt: Date;
  updatedAt: Date;
}

// API キー (ハッシュのみ。平文は持たない)
export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  // 紐づくエージェント (テナント共通キーなら null)
  agentId: string | null;
  prefix: string;
  keyHash: string;
  name: string;
  createdAt: Date;
  // 失効日時 (null なら有効)
  revokedAt: Date | null;
}
