-- CreateEnum
CREATE TYPE "EvaluationRunStatus" AS ENUM ('completed', 'failed');

-- CreateEnum
CREATE TYPE "EvaluationExclusionReason" AS ENUM ('unknown_case_id', 'duplicate_case_id', 'score_out_of_range', 'missing_score', 'unparsable_output', 'judge_unavailable', 'agent_unavailable');

-- DropIndex
DROP INDEX "EvaluationSet_tenantId_idx";

-- AlterTable
ALTER TABLE "EvaluationCase" ADD COLUMN     "position" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "EvaluationRun" ADD COLUMN     "excludedCases" INTEGER NOT NULL,
ADD COLUMN     "judgeModel" TEXT NOT NULL,
ADD COLUMN     "judgeProvider" "Provider" NOT NULL,
ADD COLUMN     "scoredCases" INTEGER NOT NULL,
ADD COLUMN     "status" "EvaluationRunStatus" NOT NULL DEFAULT 'completed',
ALTER COLUMN "accuracy" DROP NOT NULL,
ALTER COLUMN "safety" DROP NOT NULL,
ALTER COLUMN "deviation" DROP NOT NULL;

-- CreateTable
CREATE TABLE "EvaluationResult" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "setId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "accuracy" DOUBLE PRECISION,
    "safety" DOUBLE PRECISION,
    "deviation" DOUBLE PRECISION,
    "excludedReason" "EvaluationExclusionReason",

    CONSTRAINT "EvaluationResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EvaluationResult_runId_idx" ON "EvaluationResult"("runId");

-- CreateIndex
CREATE INDEX "EvaluationResult_setId_caseId_idx" ON "EvaluationResult"("setId", "caseId");

-- CreateIndex
CREATE UNIQUE INDEX "EvaluationResult_runId_caseId_key" ON "EvaluationResult"("runId", "caseId");

-- CreateIndex
CREATE UNIQUE INDEX "EvaluationCase_setId_id_key" ON "EvaluationCase"("setId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EvaluationCase_setId_position_key" ON "EvaluationCase"("setId", "position");

-- CreateIndex
CREATE INDEX "EvaluationRun_tenantId_agentId_setId_createdAt_idx" ON "EvaluationRun"("tenantId", "agentId", "setId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EvaluationRun_tenantId_id_setId_key" ON "EvaluationRun"("tenantId", "id", "setId");

-- CreateIndex
CREATE INDEX "EvaluationSet_tenantId_createdAt_idx" ON "EvaluationSet"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EvaluationSet_tenantId_name_key" ON "EvaluationSet"("tenantId", "name");

-- AddForeignKey
ALTER TABLE "EvaluationResult" ADD CONSTRAINT "EvaluationResult_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationResult" ADD CONSTRAINT "EvaluationResult_tenantId_runId_setId_fkey" FOREIGN KEY ("tenantId", "runId", "setId") REFERENCES "EvaluationRun"("tenantId", "id", "setId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationResult" ADD CONSTRAINT "EvaluationResult_setId_caseId_fkey" FOREIGN KEY ("setId", "caseId") REFERENCES "EvaluationCase"("setId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─────────────────────────────────────────────
-- ここから先は手書き。Prisma のスキーマでは表せない CHECK 制約を足す。
-- **「採点できた」と「除外した」は排他**で、どちらでもない行 (スコアも理由も無い) も、
-- 両方ある行も許さない。アプリ側の規律だけに任せると、判定を 1 か所書き落とした実装が
-- 「スコアが無いのに採点済み」の行を作り、回帰比較の分母だけが静かにずれる
-- ─────────────────────────────────────────────

-- 採点結果は「スコア 3 つが揃っている」か「除外理由がある」かのどちらか
ALTER TABLE "EvaluationResult" ADD CONSTRAINT "EvaluationResult_scored_xor_excluded" CHECK (
  ("excludedReason" IS NULL AND "accuracy" IS NOT NULL AND "safety" IS NOT NULL AND "deviation" IS NOT NULL)
  OR
  ("excludedReason" IS NOT NULL AND "accuracy" IS NULL AND "safety" IS NULL AND "deviation" IS NULL)
);

-- 実行の平均スコアは「採点できたケースが 1 件以上あるとき」だけ存在する。
-- 0 件なのに 0.0 が入っていると、Step4 の品質低下ルールが「最低品質」と読んで誤発火する
ALTER TABLE "EvaluationRun" ADD CONSTRAINT "EvaluationRun_scores_present_iff_scored" CHECK (
  ("scoredCases" > 0 AND "accuracy" IS NOT NULL AND "safety" IS NOT NULL AND "deviation" IS NOT NULL)
  OR
  ("scoredCases" = 0 AND "accuracy" IS NULL AND "safety" IS NULL AND "deviation" IS NULL)
);

-- 件数は負にならない (集計の分母・分子として使うため)
ALTER TABLE "EvaluationRun" ADD CONSTRAINT "EvaluationRun_case_counts_non_negative" CHECK (
  "scoredCases" >= 0 AND "excludedCases" >= 0
);

-- ケースの並び順は 0 始まりの通し番号 (負の値を入れさせない)
ALTER TABLE "EvaluationCase" ADD CONSTRAINT "EvaluationCase_position_non_negative" CHECK ("position" >= 0);
