// ページネーションの規則の唯一の定義 (memory / prisma の両アダプタと API 層が使う)。
//   - 並び順は createdAt 昇順 → id 昇順 (安定順序)
//   - カーソルは「前ページ最終行の (createdAt, id)」を符号化したキーセット (行 id そのものではない)。
//     行 id をカーソルにすると、その行が次ページ取得までに削除されたとき続きが取れず一覧が黙って途切れる。
//     キーセットなら比較で位置が決まるので行が消えても続きが取れ、行の存在を探る手掛かりにもならない
import type { CursorKey, Page } from './ports/types';

// 位置の型を再公開する (利用側は page.ts だけを import すればよい)
export type { CursorKey };

// 符号化前の区切り文字 (id は cuid なので ':' を含まない)
const CURSOR_SEPARATOR = ':';

// 行の位置をカーソル文字列にする (base64url。利用者には不透明な値として扱ってもらう)
export function encodeCursor(row: CursorKey): string {
  // 「ミリ秒:id」を base64url にする
  return Buffer.from(`${row.createdAt.getTime()}${CURSOR_SEPARATOR}${row.id}`).toString(
    'base64url',
  );
}

// カーソル文字列を位置へ戻す (形が違えば null。API 層はこれで 422 にし、アダプタには正しい値だけが届く)
export function decodeCursor(cursor: string): CursorKey | null {
  // base64url として復号する (不正な文字は無視されるので、形の検査は復号後に行う)
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  // 区切りで 2 つに分ける
  const separator = decoded.indexOf(CURSOR_SEPARATOR);
  if (separator <= 0 || separator === decoded.length - 1) return null;
  // ミリ秒は 10 進整数 (15 桁以内 = Date の範囲内)、id は cuid とテスト用 id に使う文字だけ
  // (base64url は任意のバイト列を復号できるため、NUL などが DB へ渡って 500 になるのを形の検査で防ぐ)
  const millis = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (!/^[0-9]{1,15}$/.test(millis) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  // 位置として返す
  return { createdAt: new Date(Number(millis)), id };
}

// 一覧の並び順 (createdAt 昇順 → id 昇順) の比較関数。負なら a が前、正なら a が後ろ、0 なら同じ位置。
// 並べる側 (memory の sort) と続きを決める側 (isAfterCursor) が同じ 1 つの比較を使う
export function compareCursorKeys(a: CursorKey, b: CursorKey): number {
  // 作成日時で比べる
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  // 同時刻なら id の文字列順で決める (順序を決定的にする)
  return byTime !== 0 ? byTime : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// 行がカーソルの位置より後ろにあるか
export function isAfterCursor(row: CursorKey, key: CursorKey): boolean {
  // 同じ比較関数で「後ろ」を判定する
  return compareCursorKeys(row, key) > 0;
}

// 1 件多く取った行を 1 ページに整形する (次ページがあれば最終行のキーセットを nextCursor にする)
export function toPage<T extends CursorKey>(rows: T[], limit: number): Page<T> {
  // 次ページがあるか (limit + 1 件取れたか)
  const hasMore = rows.length > limit;
  // 返す分だけに切り詰める
  const items = hasMore ? rows.slice(0, limit) : rows;
  // 次ページがあれば最終行の位置をカーソルにする
  return hasMore ? { items, nextCursor: encodeCursor(items[items.length - 1]) } : { items };
}
