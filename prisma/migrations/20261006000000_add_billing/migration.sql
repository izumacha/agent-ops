-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "billingCustomerId" TEXT,
ADD COLUMN     "billingSubscriptionId" TEXT;

-- CreateTable
CREATE TABLE "BillingEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "tenantId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillingEvent_tenantId_receivedAt_idx" ON "BillingEvent"("tenantId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingEvent_provider_eventId_key" ON "BillingEvent"("provider", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_billingCustomerId_key" ON "Tenant"("billingCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_billingSubscriptionId_key" ON "Tenant"("billingSubscriptionId");

-- AddForeignKey
ALTER TABLE "BillingEvent" ADD CONSTRAINT "BillingEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

