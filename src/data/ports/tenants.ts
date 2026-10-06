// テナント操作の Port (契約)。実装は adapters/memory と adapters/prisma
import type { Plan } from '@/domain/types';
import type { Page, PageQuery, TenantRecord, UserRecord, UserTokenRecord } from './types';

// テナント作成の入力。最初の admin ユーザーとそのログイントークンを同時に作る (UC-01)。
// 3 つの書き込みを 1 つの操作にするのは、途中で失敗して「admin のいないテナント」が残らないようにするため
export interface CreateTenantInput {
  // テナントの表示名
  name: string;
  // 最初の admin ユーザー
  admin: {
    email: string;
    name: string;
  };
  // admin に発行するログイントークン (平文は呼び出し側が生成し、ここにはハッシュだけ渡す)
  token: {
    prefix: string;
    tokenHash: string;
    name: string;
    expiresAt: Date;
  };
}

// テナント作成の出力 (作った 3 行)
export interface CreateTenantResult {
  tenant: TenantRecord;
  admin: UserRecord;
  token: UserTokenRecord;
}

// プラン変更の入力。**課金事業者側の id も同時に書く** — プランと id を別の操作で書くと、
// 片方だけ成功した状態 (プランは pro なのに顧客 id が無い = 次の Webhook で引けない) が残る
export interface UpdateTenantPlanInput {
  // 変更後のプラン
  plan: Plan;
  // 顧客 ID (省略すると変更しない。null を渡すと未連携へ戻す)
  billingCustomerId?: string | null;
  // サブスクリプション ID (同上)
  billingSubscriptionId?: string | null;
}

// テナント Port
export interface TenantsPort {
  // 全テナントを一覧する (プラットフォーム管理者専用。テナント境界の外側なので tenantId を取らない)
  list(query: PageQuery): Promise<Page<TenantRecord>>;
  // id でテナントを引く (無ければ null)
  findById(id: string): Promise<TenantRecord | null>;
  // 課金事業者側の顧客 ID でテナントを引く (無ければ null)。**テナント境界の外側**なので
  // tenantId を取らない — Webhook は「どのテナントの話か」を顧客 ID から決める唯一の経路
  findByBillingCustomerId(customerId: string): Promise<TenantRecord | null>;
  // テナント + 最初の admin + そのトークンを原子的に作る。admin の役割は必ず admin にする
  createWithAdmin(input: CreateTenantInput): Promise<CreateTenantResult>;
  // プラン (と課金事業者側の id) を変える。見つからなければ null。
  // **プラットフォーム管理者と Webhook だけが呼ぶ** — テナント内の admin には変えさせない
  // (課金の実体は事業者側にあるので、アプリ側で上げられると請求と権限が食い違う)
  updatePlan(tenantId: string, input: UpdateTenantPlanInput): Promise<TenantRecord | null>;
}
