// /api/v1/audit-logs/verify: 監査ログのハッシュ連鎖の検証 (admin ロール限定)。
// Step4 の受け入れ基準「監査ログの改ざん検知」を運用から確かめる経路。
import { requireAdminRole } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import type { ApiSchemas } from '@/lib/api-types';
import { verifyAuditChain, type StoredAuditRow } from '@/domain/audit/chain';
import { auditHmacSecret } from '@/lib/audit/secret';
import { AUDIT_CHAIN_VERIFY_MAX_ROWS } from '@/lib/constants';
import { parseQuery } from '@/lib/api/pagination';
import { auditChainVerifyQuerySchema } from '@/lib/validations/guardrail';
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
 * **1 回に読む件数に上限がある。** 代わりに `?fromSeq=` でその連番から検証できる
 * (直前の行のハッシュを錨にすれば続きから辿れる)。**これが無いと行数が上限を超えたテナントでは
 * 毎回同じ最古の上限件数だけを検証し続け、それ以降の行は二度と検証されない** —
 * DB を触れる相手が新しい行を書き換えても「無傷」と答える状態になる。
 * 続きがあるときは `nextFromSeq` を返すので、運用側はそれを渡して次の区間を検証する (§8)。
 */
export const GET = route(async ({ request, principal, repos }) => {
  // admin ロールであること (改ざんの有無は運用の判断に直結する情報)
  const { tenantId } = requireAdminRole(principal);
  // 読み始める連番 (省略時は先頭。形が違えば 422)
  const { fromSeq } = parseQuery(new URL(request.url), auditChainVerifyQuerySchema);
  // 鍵を読む (未設定・短すぎは 503)
  const secret = auditHmacSecret();
  // 連番の昇順で上限まで読む (錨 = 1 つ前の行のハッシュも受け取る)
  const { rows, reachedLimit, anchorHash } = await repos.auditLogs.readChain(
    tenantId,
    AUDIT_CHAIN_VERIFY_MAX_ROWS,
    fromSeq,
  );
  // **検証したいテナントを渡す。** 行の tenantId を信じるだけだと、取り出すクエリの条件が
  // 壊れて別テナントの行が返ったときに連鎖は整合しているので ok になり、対象テナントを
  // 1 行も見ていないのに「無傷」と報告される。
  // **錨も渡す** — 途中から始めるときは「1 つ前の行のハッシュ」が最初の行の prevHash と
  // 一致することまで確かめないと、区間の継ぎ目だけが検証されないまま通る
  const verification = verifyAuditChain(
    secret,
    tenantId,
    rows as StoredAuditRow[],
    secretsEqual,
    fromSeq === undefined ? undefined : { expectedSeq: fromSeq, previousHash: anchorHash },
  );
  // 続きがあるなら次に渡す連番 (最後に読んだ行の次)。無ければ付けない
  const lastSeq = rows[rows.length - 1]?.seq;
  const nextFromSeq = reachedLimit && lastSeq !== undefined ? (lastSeq + 1n).toString() : undefined;
  // 共通部分 (壊れていても検証できた件数は返す)
  const body: ApiSchemas['AuditChainVerification'] = verification.ok
    ? { ok: true, verified: verification.verified, reachedLimit, nextFromSeq }
    : {
        ok: false,
        verified: verification.verified,
        reachedLimit,
        nextFromSeq,
        // 最初に壊れた連番 (BigInt なので文字列) とその理由
        brokenSeq: verification.brokenSeq.toString(),
        reason: verification.reason,
      };
  return Response.json(body);
});
