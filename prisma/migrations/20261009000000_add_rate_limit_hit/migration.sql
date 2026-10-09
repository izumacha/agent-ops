-- CreateTable
-- レート制限の記録 (ADR-0015)。**業務データではない** — 窓から外れた行は捨ててよい。
--
-- 主キーは BIGSERIAL (他の表の cuid() と違う): アプリから id で引く経路が無く、毎分の追記が
-- 主な負荷なので、採番を DB へ任せて「数えて条件付きで 1 行入れる」を 1 文で書けるようにする。
--
-- tenantId の外部キーは張らない: key は `tenant:<id>` か `platform` で、後者はテナントに
-- 属さない (FK を張るとその枠が表現できない)。解約したテナントの行は窓から外れた時点で
-- 掃かれる (そのキーの分は consume が、二度と来ないキーの分は sweep が片付ける)。
CREATE TABLE "RateLimitHit" (
    "id" BIGSERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitHit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- そのキーの窓の中の件数 (共有の枠) と、そのキーの期限切れの掃き出し
CREATE INDEX "RateLimitHit_key_at_idx" ON "RateLimitHit"("key", "at");

-- CreateIndex
-- そのキー × 種類の件数 (追加の枠)
CREATE INDEX "RateLimitHit_key_tier_at_idx" ON "RateLimitHit"("key", "tier", "at");

-- CreateIndex
-- 期限切れの一括削除 (定期掃き。キーで絞らない)
CREATE INDEX "RateLimitHit_at_idx" ON "RateLimitHit"("at");
