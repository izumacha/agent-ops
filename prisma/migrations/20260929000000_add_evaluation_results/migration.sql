-- CreateEnum
CREATE TYPE "EvaluationRunStatus" AS ENUM ('completed', 'failed');

-- CreateEnum
CREATE TYPE "EvaluationExclusionReason" AS ENUM ('unknown_case_id', 'duplicate_case_id', 'score_out_of_range', 'missing_score', 'unparsable_output', 'judge_unavailable', 'agent_unavailable');

-- DropIndex
DROP INDEX "EvaluationSet_tenantId_idx";

-- DropIndex
-- この移行で張る (setId, id) / (setId, position) の一意索引はどちらも setId が先頭なので、
-- `WHERE setId = $1` はそちらから引ける。単独の索引は書き込みの費用を増やすだけになる
DROP INDEX "EvaluationCase_setId_idx";

-- AlterTable
-- **既存行がある DB でも通るように、いったん DEFAULT つきで足してから DEFAULT を外す。**
-- Prisma の生成そのままの `ADD COLUMN ... NOT NULL`（DEFAULT 無し）は、行が 1 件でもあると
-- PostgreSQL が「既存行に入れる値が無い」で失敗し、`prisma migrate deploy` がそこで止まる
-- （CI は毎回まっさらな DB なので緑のまま通り、壊れるのは本番の配備だけ = fail-open）。
-- DEFAULT を残さないのは、以後の INSERT で値の指定漏れを黙って埋めさせないため（アプリは必ず書く）
ALTER TABLE "EvaluationCase" ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0;
-- 既存行の並び順を採番し直す。全部 0 のままだと、この後に張る一意索引
-- (setId, position) が「1 セットに 2 件以上」の DB で必ず衝突する。
-- 採番は id の昇順（内容から順序を決められないので、決まった順に 0 始まりで振る）
UPDATE "EvaluationCase" AS target
SET "position" = numbered."rowNumber" - 1
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "setId" ORDER BY "id") AS "rowNumber"
  FROM "EvaluationCase"
) AS numbered
WHERE target."id" = numbered."id";
ALTER TABLE "EvaluationCase" ALTER COLUMN "position" DROP DEFAULT;

-- AlterTable
-- 平均スコアを null 許容にするのが先。既存行はスコアを持っているので、この後の
-- CHECK 制約 (scoredCases > 0 のときだけスコアがある) を満たす件数を埋める必要がある
ALTER TABLE "EvaluationRun"
ALTER COLUMN "accuracy" DROP NOT NULL,
ALTER COLUMN "safety" DROP NOT NULL,
ALTER COLUMN "deviation" DROP NOT NULL;

-- 採点として使えるか。既存行は除外の概念が無かった頃のものなので completed 扱いでよい
ALTER TABLE "EvaluationRun" ADD COLUMN     "status" "EvaluationRunStatus" NOT NULL DEFAULT 'completed';

-- 除外件数。旧スキーマに除外は無かったので既存行は 0 件で正しい
ALTER TABLE "EvaluationRun" ADD COLUMN     "excludedCases" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "EvaluationRun" ALTER COLUMN "excludedCases" DROP DEFAULT;

-- 採点件数。既存行はスコアを持つので 0 にすると CHECK に反する。
-- 旧スキーマでは「セットの全ケースを採点した」以外の解釈が無いため、セットのケース数で埋める
-- （ケースが 1 件も無いセットでも CHECK を満たせるよう最低 1 とする）
ALTER TABLE "EvaluationRun" ADD COLUMN     "scoredCases" INTEGER NOT NULL DEFAULT 0;
UPDATE "EvaluationRun" AS run
SET "scoredCases" = GREATEST(
  (SELECT count(*) FROM "EvaluationCase" AS c WHERE c."setId" = run."setId"),
  1
)
WHERE run."accuracy" IS NOT NULL;
ALTER TABLE "EvaluationRun" ALTER COLUMN "scoredCases" DROP DEFAULT;

-- どの judge が採点したか。**旧スキーマにこの列は無く、既存行の採点者は本当に分からない**ので、
-- モデル名は実在しない綴り 'unknown' を入れて「不明」を読み取れるようにする
-- （provider は enum なので不明を表せない。値は必須なので既定の 1 つを置くだけで、
-- 'unknown' と対で見ないと意味を持たない）。
-- なお、この移行が触れる既存行は手で入れた行だけ — Step3 より前にこの表へ書く経路は無かった
ALTER TABLE "EvaluationRun" ADD COLUMN     "judgeProvider" "Provider" NOT NULL DEFAULT 'anthropic';
ALTER TABLE "EvaluationRun" ALTER COLUMN "judgeProvider" DROP DEFAULT;
ALTER TABLE "EvaluationRun" ADD COLUMN     "judgeModel" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "EvaluationRun" ALTER COLUMN "judgeModel" DROP DEFAULT;

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
