// 上限付きの `fetch`（`scripts/` のスクリプトが共有する）。
//
// **Node の global fetch は既定でタイムアウトしない。** 相手が接続を受けたまま応答を返さない
// 状態になると `await fetch(...)` が解決せず、**ループも終了コードの判定も一度も到達しない** —
// スクリプトは cron / systemd timer / CI のジョブ枠を掴んだまま止まり、しかも「失敗」としても
// 現れない（スケジューラ側のジョブ単位の上限まで放置される）。このリポジトリは同じ失敗を
// 既に踏んでおり（デモの筋の計測）、ここはその手当てを 1 か所に集めたもの（§6 DRY）。
//
// **定数だけと関数 1 つで、import も副作用も持たない**（`scripts/` の静的検査が許す形に保つ）。

/** 既定の上限（ミリ秒）。1 要求が返るまでに許す時間 */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/**
 * 上限付きで叩く。
 * @param {string | URL} url 叩く先
 * @param {RequestInit} [init] `fetch` の設定（`signal` はここが上書きする）
 * @param {number} [timeoutMs] 上限（ミリ秒）
 * @returns {Promise<Response>} 応答
 */
export function fetchWithTimeout(url, init = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  // 上限を過ぎたら中断する signal を付けて叩く
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
