-- 一覧のカーソル送り (createdAt, id 順) に合わせた索引の追加 (CLAUDE.md §8「よく絞り込む列にインデックスを張る」)。
-- Tenant: GET /tenants (プラットフォーム管理者) は createdAt 順の keyset で読むが索引が無く、全件走査 + ソートになっていた。
-- UserToken: ユーザー別一覧 (tenantId, userId で絞り createdAt 順) を 1 つの索引で賄い、単独の userId 索引は
--            (tenantId, userId, createdAt) が先頭 2 列で代替できるため落とす (複合 FK の Cascade 解決も同じ索引が受ける)。

-- DropIndex
DROP INDEX "UserToken_userId_idx";

-- CreateIndex
CREATE INDEX "Tenant_createdAt_idx" ON "Tenant"("createdAt");

-- CreateIndex
CREATE INDEX "UserToken_tenantId_userId_createdAt_idx" ON "UserToken"("tenantId", "userId", "createdAt");

