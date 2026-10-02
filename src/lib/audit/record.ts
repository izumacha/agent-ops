// 監査ログを書く唯一の経路。**`repos.auditLogs.append` を直接呼ばない。**
//
// 1 か所に集める理由は 3 つある:
//   - 鍵（`AUDIT_HMAC_SECRET`）に触るのをここだけに限る（データ層は鍵を知らない）
//   - ハッシュの計算を書き込み側と検証側で同じ関数に通す（作り方が食い違うと全行が検証に失敗する）
//   - `createdAt` を「ハッシュに入れた値そのもの」にする（DB の既定値に任せると別の瞬間になる）
import type { Repositories } from '@/data/ports';
import type { AuditLogRecord } from '@/data/ports';
import { auditRowHash, type AuditPayload } from '@/domain/audit/chain';
import type { AuditAction, AuditTargetType } from '@/domain/audit/action';
import { auditHmacSecret } from '@/lib/audit/secret';

/** 1 行の監査記録。`seq` / `prevHash` / `hash` / `createdAt` は呼び出し側が渡さない */
export interface AuditEntry {
  // 記録するテナント（必ず入れる。ADR-0002）
  tenantId: string;
  // 操作したユーザー（ガードレールの自動発火など、人が起点でない操作は null）
  actorId: string | null;
  // 操作名（語彙は src/domain/audit/action.ts）
  action: AuditAction;
  // 対象の種類と ID
  targetType: AuditTargetType;
  targetId: string;
  // 操作の詳細。**機微情報を入れない**（しきい値・実測値・状態のような「判断の根拠」だけ）
  payload: AuditPayload | null;
}

/**
 * 監査ログを 1 行追記する。鍵が未設定・短すぎなら **503 を投げる**（`auditHmacSecret` の fail-closed）。
 *
 * **`createdAt` はここで決めて、保存とハッシュの両方へ同じ値を渡す。** 他の表の慣習
 * （発生日時は DB の既定値に任せる）に従うと、ハッシュに入れた時刻とトランザクション開始時刻が
 * 別の瞬間になり、全行が初日から `hash_mismatch` になる。
 */
export async function recordAudit(
  repos: Repositories,
  entry: AuditEntry,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AuditLogRecord> {
  // 鍵を読む（未設定なら 503 で落ちる。鍵なしのハッシュで代用しない）
  const secret = auditHmacSecret(env);
  // 記録日時を 1 回だけ決める（この値が保存され、同じ値がハッシュに入る）
  const createdAt = new Date();
  // 追記する。採番した `seq` / `prevHash` はアダプタから `computeHash` 経由で渡ってくる
  return repos.auditLogs.append(
    {
      tenantId: entry.tenantId,
      actorId: entry.actorId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      payload: entry.payload,
      createdAt,
    },
    // アダプタが採番してから呼ぶ（seq と prevHash がハッシュの入力に入るため、採番前には計算できない）
    ({ seq, prevHash, id }) =>
      auditRowHash(secret, {
        id,
        tenantId: entry.tenantId,
        seq,
        actorId: entry.actorId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        payload: entry.payload,
        createdAt,
        prevHash,
      }),
  );
}
