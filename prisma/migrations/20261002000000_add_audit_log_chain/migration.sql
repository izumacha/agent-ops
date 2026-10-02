-- ─────────────────────────────────────────────
-- ここは手書き。**連鎖の列を足す前に、表が空であることを確かめて空でなければ止める。**
--
-- 他の移行 (20260929000000_add_evaluation_results) が採っている
-- 「DEFAULT つきで足す → UPDATE で埋める → DROP DEFAULT」の手順が、この表では使えない:
-- hash は HMAC-SHA256 で、鍵 (AUDIT_HMAC_SECRET) はアプリ側の環境変数にしかないため
-- **SQL では既存行の正しいハッシュを計算できない**。仮の値で埋めると、その行は
-- 「検証に失敗する行」として最初から埋まることになり、改ざん検知が初日から赤くなる。
--
-- 空である根拠: この表に書き込むコードは Step4 まで 1 行も存在しない (src/ と prisma/seed.ts に
-- AuditLog への書き込みは無い)。したがってどの環境でも 0 行で、ここは通常は何もしない検査。
-- それでも検査を置くのは、万一行があったときに**黙って壊れた連鎖を作らない**ため (fail-closed)。
-- ─────────────────────────────────────────────
DO $$
DECLARE
  -- 既存行の件数を入れる変数
  existing_rows bigint;
BEGIN
  -- 監査ログの行数を数える
  SELECT count(*) INTO existing_rows FROM "AuditLog";
  -- 1 行でもあれば、正しいハッシュを埋められないので移行を中止する
  IF existing_rows > 0 THEN
    RAISE EXCEPTION
      'AuditLog に既存行が % 件あります。ハッシュ連鎖の初期値は SQL では計算できない (鍵がアプリ側にある) ため、この移行は適用できません。既存行の扱いを決めてから進めてください',
      existing_rows;
  END IF;
END
$$;

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "hash" TEXT NOT NULL,
ADD COLUMN     "prevHash" TEXT,
ADD COLUMN     "seq" BIGINT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_tenantId_seq_key" ON "AuditLog"("tenantId", "seq");


-- ─────────────────────────────────────────────
-- ここから先も手書き。**監査ログを DB のレベルで追記専用にする。**
--
-- ハッシュ連鎖だけでは「改ざんを後から見つけられる」までで、「改ざんを防ぐ」ことはできない。
-- アプリ側の規律 (書き込みは recordAudit 経由だけ) も、生 SQL や psql を直に叩く経路には効かない。
-- UC-09 の事後条件「監査ログに操作者・時刻・対象が残る (改ざん検知付き)」を満たすには、
-- 「消せない・書き換えられない」を表の側に置く必要がある。
--
-- DELETE だけ逃げ道を用意するのは、テナント単位の消去要求に応える経路が要るため
-- (AuditLog.tenant は onDelete: Cascade なので、テナント行を消すと監査ログも消えようとする)。
-- 逃げ道は「そのトランザクションで明示的に宣言した場合だけ」に絞る。
-- 契約テストの後始末 (TRUNCATE ... CASCADE) は行トリガを発火しないので、宣言は要らない。
-- ─────────────────────────────────────────────

-- 追記専用を強制する関数 (UPDATE は常に拒否、DELETE は宣言があるときだけ通す)
CREATE OR REPLACE FUNCTION "audit_log_append_only"() RETURNS trigger AS $$
BEGIN
  -- 書き換えは例外なく拒否する (「訂正」の余地を作らない。訂正は新しい行を足して表現する)
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'AuditLog は追記専用です (UPDATE は許可されていません)';
  END IF;
  -- 削除は、そのトランザクションで明示的に許可を宣言したときだけ通す
  IF TG_OP = 'DELETE' THEN
    -- 第 2 引数 true は「未設定なら NULL を返す」の意味 (未設定でエラーにしない)
    IF current_setting('agent_ops.allow_audit_delete', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'AuditLog の DELETE は SET LOCAL agent_ops.allow_audit_delete = ''on'' を宣言したトランザクション内でのみ許可されます';
    END IF;
    -- 宣言があるので削除を通す (BEFORE DELETE では OLD を返すと削除が進む)
    RETURN OLD;
  END IF;
  -- ここには来ない (トリガは UPDATE と DELETE にだけ張る)。保険として素通りさせる
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 上の関数を AuditLog の UPDATE / DELETE に張る (行ごとに評価する)
CREATE TRIGGER "AuditLog_append_only"
BEFORE UPDATE OR DELETE ON "AuditLog"
FOR EACH ROW EXECUTE FUNCTION "audit_log_append_only"();
