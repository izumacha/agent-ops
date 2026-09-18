-- 一覧のカーソル送り (createdAt, id 順) に合わせた索引の追加 (CLAUDE.md §8「よく絞り込む列にインデックスを張る」)。
-- Tenant: GET /tenants (プラットフォーム管理者) は createdAt 順の keyset で読むが索引が無く、全件走査 + ソートになっていた。
-- UserToken: ユーザー別一覧 (tenantId, userId で絞り createdAt 順) を 1 つの索引で賄い、単独の userId 索引と
--            (tenantId, createdAt) 索引は落とす (前者は先頭 2 列で代替でき、後者はどのクエリも使わない —
--            認証は tokenHash の一意索引で引き、テナント全体のトークン一覧は無い。テナント Cascade は先頭列で受ける)。

-- DropIndex
DROP INDEX "UserToken_userId_idx";

-- DropIndex
DROP INDEX "UserToken_tenantId_createdAt_idx";

-- CreateIndex
CREATE INDEX "Tenant_createdAt_idx" ON "Tenant"("createdAt");

-- CreateIndex
CREATE INDEX "UserToken_tenantId_userId_createdAt_idx" ON "UserToken"("tenantId", "userId", "createdAt");

