// 監査ログを書く唯一の経路。**`repos.auditLogs.append` を直接呼ばない。**
//
// 1 か所に集める理由は 3 つある:
//   - 鍵（`AUDIT_HMAC_SECRET`）に触るのをここだけに限る（データ層は鍵を知らない）
//   - ハッシュの計算を書き込み側と検証側で同じ関数に通す（作り方が食い違うと全行が検証に失敗する）
//   - `createdAt` を「ハッシュに入れた値そのもの」にする（DB の既定値に任せると別の瞬間になる）
import type { Repositories } from '@/data/ports';
import type { AuditLogRecord } from '@/data/ports';
import { auditRowHash, isAuditPayload, type AuditPayload } from '@/domain/audit/chain';
import type { AuditAction, AuditTargetType } from '@/domain/audit/action';
import { auditHmacSecret } from '@/lib/audit/secret';
import { ApiError } from '@/lib/api/errors';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { API_MESSAGES } from '@/lib/constants';

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
 * 監査ログを**書ける状態か**だけを先に確かめる（鍵が未設定・短すぎなら 503 を投げる）。
 *
 * **人の操作では、状態を変える前にこれを呼ぶ。** 変えてから `recordAudit` が 503 を投げると、
 * 「状態は変わったのに記録が無く、しかも再試行は『既にその状態だ』で永久に失敗する」形になる
 * （実測: 鍵が未設定のとき `POST /incidents/{id}/resolve` は 503 を返しながら incident を
 * `resolved` にし、鍵を設定して再試行しても 409 `already_resolved` が返り続けた。
 * UC-09 の事後条件「監査ログに残る」が**恒久的に達成不能**になる）。
 *
 * **これは順序の手当てで、原子性の保証ではない。** 状態変更と追記は別のトランザクションなので、
 * 追記そのものが DB 障害で落ちる窓は残る（そのときは 503 を返し、状態だけが変わる）。
 * 1 つのトランザクションにまとめるには Port をまたぐ設計が要るので、宿題として ADR-0010 に残す。
 * @param env 環境変数（テストから差し替えるため）
 */
export function assertAuditConfigured(env: NodeJS.ProcessEnv = process.env): void {
  // 鍵を読めなければ例外（戻り値は使わない。読めることだけを確かめる）
  auditHmacSecret(env);
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
  // **payload の形を実行時に確かめる。** 列の型は `Json?` なので型注釈では守れず、入れ子が
  // 混ざると正規化がその階層を並べ替えないため、JSONB の内部順序に依存してハッシュが不定に揺れる
  // （保存して読み直しただけで検証に失敗しうる）。追記してからでは直せないので入口で止める
  if (entry.payload !== null && !isAuditPayload(entry.payload)) {
    throw new ApiError(HTTP_STATUS.INTERNAL_SERVER_ERROR, API_MESSAGES.internal);
  }
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
