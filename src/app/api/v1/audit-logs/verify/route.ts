// /api/v1/audit-logs/verify: 監査ログのハッシュ連鎖の検証 (admin ロール限定)。
// Step4 の受け入れ基準「監査ログの改ざん検知」を運用から確かめる経路。
import { requireAdminRole } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import type { ApiSchemas } from '@/lib/api-types';
import { verifyAuditChain, type StoredAuditRow } from '@/domain/audit/chain';
import { auditHmacSecret } from '@/lib/audit/secret';
import { AUDIT_CHAIN_VERIFY_MAX_ROWS } from '@/lib/constants';
import { secretsEqual } from '@/lib/tokens';

/**
 * GET /audit-logs/verify (verifyAuditLogs)
 *
 * **壊れていても 200 を返す。** 「連鎖が壊れている」はこのエンドポイントの正常な答えで、
 * HTTP のエラーにすると監視が「API が落ちた」と読む。壊れているかは本文の `ok` が示す。
 *
 * **鍵が未設定・短すぎなら 503** (`auditHmacSecret` の fail-closed)。鍵なしで「無傷」と
 * 答えるのが最悪の倒れ方なので、検証できないことをはっきり返す。
 *
 * **ページ送りを持たない。** 連鎖は先頭から順にしか辿れない (前の行のハッシュが要る) ので
 * 途中から始められない。代わりに読む件数に上限を置き、上限に達したかを返す (§8)。
 */
export const GET = route(async ({ principal, repos }) => {
  // admin ロールであること (改ざんの有無は運用の判断に直結する情報)
  const { tenantId } = requireAdminRole(principal);
  // 鍵を読む (未設定・短すぎは 503)
  const secret = auditHmacSecret();
  // 連番の昇順で上限まで読む
  const { rows, reachedLimit } = await repos.auditLogs.readChain(
    tenantId,
    AUDIT_CHAIN_VERIFY_MAX_ROWS,
  );
  // **検証したいテナントを渡す。** 行の tenantId を信じるだけだと、取り出すクエリの条件が
  // 壊れて別テナントの行が返ったときに連鎖は整合しているので ok になり、対象テナントを
  // 1 行も見ていないのに「無傷」と報告される
  const verification = verifyAuditChain(secret, tenantId, rows as StoredAuditRow[], secretsEqual);
  // 共通部分 (壊れていても検証できた件数は返す)
  const body: ApiSchemas['AuditChainVerification'] = verification.ok
    ? { ok: true, verified: verification.verified, reachedLimit }
    : {
        ok: false,
        verified: verification.verified,
        reachedLimit,
        // 最初に壊れた連番 (BigInt なので文字列) とその理由
        brokenSeq: verification.brokenSeq.toString(),
        reason: verification.reason,
      };
  return Response.json(body);
});
