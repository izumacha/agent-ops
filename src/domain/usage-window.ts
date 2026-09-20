// 日次集計の「期間」の規則。**日の境目は UTC** で、API・memory アダプタ・prisma アダプタ (SQL) が
// この規則を共有する。
//
// **なぜ UTC に固定するか**: 日境界をサーバのローカル時刻にすると、配備先のタイムゾーンが変わるだけで
// 同じデータの日次集計が変わる (請求の根拠が環境依存になる)。テナントごとの表示タイムゾーンは
// Step5 のダッシュボードで「表示の都合」として扱い、記録と集計は UTC のままにする。

// 日付として受け付ける形 (YYYY-MM-DD だけ。'2026-9-1' や ISO の日時は受け付けない)
const UTC_DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
// 1 日のミリ秒数 (日数の計算に使う)
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

/** 集計する期間 (開始は含み、終了は含まない半開区間) */
export interface UsageWindow {
  // 期間の開始 (UTC のその日の 0 時)
  start: Date;
  // 期間の終了 (含まない。終了日の翌日の UTC 0 時)
  endExclusive: Date;
  // 期間の長さ (日数。1 以上)
  days: number;
}

/** 期間を組み立てられなかった理由 (API 層が文言を選ぶために使う) */
export type UsageWindowError = 'invalid_day' | 'reversed' | 'too_long';

/** 期間の組み立て結果 (成功なら期間、失敗なら理由) */
export type UsageWindowResult =
  { ok: true; window: UsageWindow } | { ok: false; reason: UsageWindowError };

/**
 * 'YYYY-MM-DD' を UTC のその日の 0 時として読む。形が違う・存在しない日付 (2026-02-30 等) は null。
 * **Date の自動繰り上がりに頼らない** — `new Date('2026-02-30')` は 3 月 2 日になり、
 * 利用者が指定していない日の集計を黙って返すことになる。
 */
export function parseUtcDay(text: string): Date | null {
  // 形を先に見る (固定長の繰り返しなので ReDoS の余地は無い)
  const matched = UTC_DAY_PATTERN.exec(text);
  // 形が違えば読めない
  if (!matched) return null;
  // 年・月・日を数値にする (正規表現が数字だけを通しているので Number で安全)
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  // UTC の 0 時として組み立てる
  const date = new Date(Date.UTC(year, month - 1, day));
  // 組み立てた日付が元の年月日と一致するかを確かめる (一致しなければ存在しない日付だった)
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  // 存在する日付だけを返す
  return date;
}

/** Date を UTC の 'YYYY-MM-DD' にする (集計結果のキーの形はここだけが決める) */
export function formatUtcDay(date: Date): string {
  // ISO 文字列は必ず UTC なので、その日付部分を切り出す
  return date.toISOString().slice(0, 'YYYY-MM-DD'.length);
}

/** Date を UTC のその日の 0 時へ丸める (memory アダプタの集計キーに使う) */
export function startOfUtcDay(date: Date): Date {
  // 年月日だけを取り出して 0 時として組み立て直す
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * 開始日・終了日 (どちらも 'YYYY-MM-DD'、終了日を含む) から集計期間を組み立てる。
 * 日数の上限を超える指定は拒否する (無制限の期間は全件走査になり、§9 のリソース枯渇そのもの)。
 */
export function resolveUsageWindow(
  fromText: string,
  toText: string,
  maxDays: number,
): UsageWindowResult {
  // 開始日を読む
  const from = parseUtcDay(fromText);
  // 終了日を読む
  const to = parseUtcDay(toText);
  // どちらかが読めなければ理由を付けて失敗
  if (from === null || to === null) return { ok: false, reason: 'invalid_day' };
  // 開始が終了より後なら、指定の取り違えとして拒否する (黙って空の結果を返さない)
  if (from.getTime() > to.getTime()) return { ok: false, reason: 'reversed' };
  // 終了日を含めるため、終了日の翌日 0 時を「含まない終わり」にする
  const endExclusive = new Date(to.getTime() + MILLIS_PER_DAY);
  // 期間の日数 (開始日と終了日が同じなら 1 日)
  const days = Math.round((endExclusive.getTime() - from.getTime()) / MILLIS_PER_DAY);
  // 上限を超える期間は拒否する
  if (days > maxDays) return { ok: false, reason: 'too_long' };
  // ここまで通れば期間として使える
  return { ok: true, window: { start: from, endExclusive, days } };
}
