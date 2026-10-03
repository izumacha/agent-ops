// エージェントの予算（`Agent.budgetMicroUsd`）の強制。ADR-0007 の「残る宿題」のうち
// 「予算は台帳上の宣言で、強制ではない」を閉じる。
//
// **ガードレールのコストルールとは別物。** ルールは「窓の中の料金がしきい値を超えたら
// インシデントを記録して停止する」という運用の仕組みで、予算は「このエージェントに
// 当月それ以上使わせない」という上限。前者は停止という状態変化を伴い、後者はその要求を
// 断るだけ（状態は変えない）。`Incident` を作らないのは、`Incident.ruleId` が NOT NULL で
// 予算はルールではないため。
import type { AgentRecord, Repositories } from '@/data/ports';
import { utcMonthWindow } from '@/domain/usage-window';
import { ApiError } from '@/lib/api/errors';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { API_MESSAGES } from '@/lib/constants';

/** 予算を超えているときの例外（403）。停止中のエージェントと同じ扱いにそろえる */
function budgetExceededError(): ApiError {
  // 403: 認証は通っているが、この呼び出しは許されない
  return new ApiError(HTTP_STATUS.FORBIDDEN, API_MESSAGES.budgetExceeded);
}

/**
 * 当月（UTC）の累計コストが予算を超えていれば **403 を投げる**。超えていなければ何もしない。
 *
 * **上流を呼ぶ前に確かめる**（中継してから断っても課金は発生してしまう）。
 *
 * **予算が未設定（null）なら問い合わせもしない。** 設定していないエージェントの中継に
 * 1 クエリ増やさないため（§8）。予算を設定したエージェントだけが 1 クエリを負担する。
 *
 * **比較は BigInt のまま行う。** `Number()` を挟むと 2^53 マイクロ USD（約 90 億ドル）を
 * 超える額で「超えていない」ことになる。実際には届かない額だが、金額をすべて BigInt で
 * 扱うという約束（ADR-0002）をここで崩すと、崩した箇所だけが後から見つけにくくなる。
 *
 * **ちょうど予算に達した時点で断る**（`>=`）。予算は「ここまで使ってよい」上限なので、
 * 到達後の呼び出しはもう上限の外。1 回の呼び出しの料金は呼ぶ前には分からないので、
 * 「超えそうなら断る」判定はできない（ADR-0010 に残る境界として記録）。
 */
export async function assertWithinBudget(
  repos: Repositories,
  input: { tenantId: string; agent: AgentRecord; now: Date },
): Promise<void> {
  // 予算そのもの（未設定なら上限は無い）
  const budget = input.agent.budgetMicroUsd;
  // 未設定なら何も確かめない（クエリも投げない）
  if (budget === null) return;
  // 当月（UTC）の半開区間
  const month = utcMonthWindow(input.now);
  // そのエージェントの当月の累計（テナント条件は Port が必ず差し込む）
  const totals = await repos.usageEvents.windowTotals(input.tenantId, {
    start: month.start,
    endExclusive: month.endExclusive,
    agentId: input.agent.id,
  });
  // 予算に達していれば断る（BigInt どうしの比較）
  if (totals.costMicroUsd >= budget) throw budgetExceededError();
}
