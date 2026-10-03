// 評価セットと評価実行の Port (契約)。読み書きは必ずテナントで絞る (ADR-0002)。
// **評価ケースは親のセット経由でしか触らない** — 子テーブルに tenantId を持たせない代わりに、
// 親を tenantId で絞ってから辿る規律を Port の形で強制する (docs/spec.md §3)
import type { EvaluationRunStatus, Provider } from '@/domain/types';
import type {
  EvaluationCaseRecord,
  EvaluationResultRecord,
  EvaluationRunRecord,
  EvaluationSetRecord,
  Page,
  PageQuery,
} from './types';

// セットに入れる 1 ケース分の入力 (並び順は配列の順)
export interface EvaluationCaseInput {
  // エージェントへの入力
  input: string;
  // 期待する出力 (無ければ null)
  expected: string | null;
}

// 評価セットの作成入力
export interface CreateEvaluationSetInput {
  tenantId: string;
  // 表示名 (テナント内で一意)
  name: string;
  // ケース (1 件以上。配列の順が position になる)
  cases: readonly EvaluationCaseInput[];
}

// セットとその中身 (詳細表示と実行で使う)
export interface EvaluationSetWithCases {
  set: EvaluationSetRecord;
  // position の昇順
  cases: EvaluationCaseRecord[];
}

// 1 ケース分の採点結果の保存入力
export interface EvaluationResultInput {
  // どのケースの結果か
  caseId: string;
  // 採点できたときのスコア (除外したケースでは null)
  accuracy: number | null;
  safety: number | null;
  deviation: number | null;
  // 除外したときの理由 (採点できたケースでは null)
  excludedReason: EvaluationResultRecord['excludedReason'];
}

// 評価実行の保存入力 (実行そのものは API 層が行い、ここは結果の保存だけを受け持つ)
export interface CreateEvaluationRunInput {
  tenantId: string;
  agentId: string;
  setId: string;
  accuracy: number | null;
  safety: number | null;
  deviation: number | null;
  status: EvaluationRunStatus;
  scoredCases: number;
  excludedCases: number;
  judgeProvider: Provider;
  judgeModel: string;
  // ケース単位の結果 (セットのケースと 1 対 1)
  results: readonly EvaluationResultInput[];
}

// 実行とその結果
export interface EvaluationRunWithResults {
  run: EvaluationRunRecord;
  // ケースの position 昇順
  results: EvaluationResultRecord[];
}

// 実行一覧の絞り込み (回帰比較のため、エージェントとセットで絞れるようにする)
export interface EvaluationRunFilter {
  agentId?: string;
  setId?: string;
}

// 評価 Port
export interface EvaluationsPort {
  // 評価セットを作る (名前が重複していれば DuplicateError)
  createSet(input: CreateEvaluationSetInput): Promise<EvaluationSetWithCases>;
  // 評価セットを一覧する (テナント内、createdAt 昇順)
  listSets(tenantId: string, query: PageQuery): Promise<Page<EvaluationSetRecord>>;
  // 評価セットをケースごと引く (他テナントのセットは null)
  findSet(tenantId: string, setId: string): Promise<EvaluationSetWithCases | null>;
  // 実行結果を保存する (エージェントかセットが同テナントに無ければ null)
  createRun(input: CreateEvaluationRunInput): Promise<EvaluationRunWithResults | null>;
  // 実行を一覧する (テナント内、createdAt 昇順。絞り込みは任意)
  listRuns(
    tenantId: string,
    query: PageQuery,
    filter?: EvaluationRunFilter,
  ): Promise<Page<EvaluationRunRecord>>;
  // 実行を結果ごと引く (他テナントの実行は null)
  findRun(tenantId: string, runId: string): Promise<EvaluationRunWithResults | null>;
  // **同じエージェント × 同じセット × 同じ judge の、その実行より前の最新の `completed` な実行**
  // (回帰比較の相手)。`failed` はスコアが null で差を出せないので飛ばし、別の judge で採点した実行は
  // 比べても意味が無いので飛ばす (prisma/schema.prisma の status / judgeProvider の説明)。
  // 無ければ null (初回の実行、judge を替えた直後、前が failed しか無い場合は比較相手が無い)
  findPreviousRun(tenantId: string, run: EvaluationRunRecord): Promise<EvaluationRunRecord | null>;
  // **そのエージェントの最新の `completed` な実行** (品質低下ルールが読む相手)。
  // `failed` を飛ばすのは、除外が多すぎた実行のスコアを「品質が落ちた」と読むのが誤判定だから
  // (採点できていないことと品質が低いことは別)。1 度も実行していなければ null で、
  // そのときルールは発火しない (測れていないものを「悪い」と読まない。fail-safe)。
  //
  // **`since` より前の実行は見ない** (品質ルールの集計窓。省略すると全期間)。
  // 窓を無視すると「3 か月前に 1 度だけ走って低い点だった」エージェントが、その後 1 度も
  // 評価していないのに毎回の判定で停止し続ける (インシデントを解決して復帰させても、
  // 次の判定で同じ古い実行を読んで再び止まる = ルールを無効にするまで抜け出せない)
  findLatestCompletedRun(
    tenantId: string,
    agentId: string,
    since?: Date,
  ): Promise<EvaluationRunRecord | null>;
}
