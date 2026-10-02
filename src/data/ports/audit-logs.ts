// 監査ログの Port (契約)。**追記と読み出しだけ**で、更新・削除のメソッドを持たない —
// 持たせないこと自体が「追記専用」の表明で、DB 側の追記専用トリガと対になる (ADR-0010)。
// 読み書きは必ずテナントで絞る (ADR-0002)。
import type { AuditPayload } from '@/domain/audit/chain';
import type { AuditLogRecord, Page, PageQuery } from './types';

// 1 行を追記する入力。**`seq` / `prevHash` / `hash` は呼び出し側が渡さない** —
// 連番の採番と連鎖の結線はアダプタが「直前の行をロックしてから」行う必要があり、
// 呼び出し側に任せると 2 つの要求が同じ連番を採って連鎖が枝分かれする。
//
// **`createdAt` は必須で、DB の既定値に任せない。** ハッシュに入れる時刻と保存される時刻が
// 別の瞬間になると全行が検証に失敗するため (理由は src/domain/audit/chain.ts の
// AuditChainRow のコメント)。アダプタが決めるのではなく、ハッシュを計算する側が渡す。
export interface AppendAuditLogInput {
  tenantId: string;
  // 操作したユーザー (システム操作なら null)
  actorId: string | null;
  // 操作名 (例: agent.suspend)
  action: string;
  // 対象の種類と ID
  targetType: string;
  targetId: string;
  // 操作の詳細 (機微情報は入れない。平坦な辞書に限る)
  payload: AuditPayload | null;
  // 記録日時 (ハッシュを計算した値そのもの)
  createdAt: Date;
}

// 追記に必要な「ハッシュを計算する関数」。**アダプタは鍵を知らない** —
// 連番を採ってからでないとハッシュを計算できない (seq と prevHash がハッシュの入力に入る) ので、
// アダプタが「採番した値を渡してハッシュを受け取る」形にする。鍵と計算方法はアプリ側
// (src/lib/audit/record.ts) が持ち、データ層は鍵に触らない
export interface AuditHashInput {
  seq: bigint;
  prevHash: string | null;
  // 採番より前に決まっている値 (呼び出し側が渡した入力と同じもの)
  id: string;
}

// 監査ログ Port
export interface AuditLogsPort {
  /**
   * 1 行を追記する。**連番の採番・連鎖の結線・ハッシュの確定を 1 つのトランザクションで行う。**
   *
   * `computeHash` は「採番した `seq` と `prevHash`、そして採番前に決めた `id`」を受け取って
   * ハッシュを返す。アダプタはそれをそのまま保存する (鍵も計算方法も知らない)。
   * 同時に 2 つの要求が来ても連番が重複しないよう、アダプタは直前の行をロックしてから採番する。
   */
  append(
    input: AppendAuditLogInput,
    computeHash: (hashInput: AuditHashInput) => string,
  ): Promise<AuditLogRecord>;
  // 一覧する (テナント内、createdAt 昇順)
  list(tenantId: string, query: PageQuery): Promise<Page<AuditLogRecord>>;
  /**
   * 連鎖の検証のために**テナントの全行を seq の昇順で**読む。
   *
   * ページ送りを持たないのは、連鎖の検証が「1 行目から最後まで順に」たどる操作で、
   * 途中から始められないため (前の行のハッシュが要る)。代わりに `limit` で読む件数に上限を置き、
   * 上限に達したかを返す — 行数が増えても 1 回の要求が無制限に重くならないようにする (§8)。
   */
  readChain(
    tenantId: string,
    limit: number,
  ): Promise<{ rows: AuditLogRecord[]; reachedLimit: boolean }>;
}
