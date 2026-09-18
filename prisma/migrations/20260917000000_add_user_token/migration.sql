-- Step1: ログイントークン (UserToken) と User.disabledAt の追加、一覧のカーソル送り (createdAt, id 順) に合わせた索引の整理。
-- 単独の tenantId 索引は (tenantId, createdAt) に置き換える。UserToken の索引は認証用の tokenHash 一意索引と
-- ユーザー別一覧用の (tenantId, userId, createdAt) だけ (テナント全体のトークン一覧は無い。テナント Cascade は先頭列で受ける)。

-- DropIndex
DROP INDEX "User_tenantId_idx";

-- DropIndex
DROP INDEX "Agent_tenantId_status_idx";

-- DropIndex
DROP INDEX "ApiKey_tenantId_idx";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "disabledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "UserToken" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "UserToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserToken_tokenHash_key" ON "UserToken"("tokenHash");

-- CreateIndex
CREATE INDEX "UserToken_tenantId_userId_createdAt_idx" ON "UserToken"("tenantId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "Tenant_createdAt_idx" ON "Tenant"("createdAt");

-- CreateIndex
CREATE INDEX "User_tenantId_createdAt_idx" ON "User"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_tenantId_id_key" ON "User"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Agent_tenantId_createdAt_idx" ON "Agent"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "Agent_tenantId_status_createdAt_idx" ON "Agent"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ApiKey_tenantId_createdAt_idx" ON "ApiKey"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "UserToken" ADD CONSTRAINT "UserToken_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserToken" ADD CONSTRAINT "UserToken_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

