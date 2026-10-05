// 監査ログの連番 (`AuditLog.seq`) が取りうる値の範囲。**定数だけを持つモジュール**。
//
// **なぜ `chain.ts` から分けるか**: 範囲の値は API のエラー文言（`src/lib/constants.ts` の
// `API_MESSAGES`）にも出したいが、`constants.ts` は `'use client'` のフォームから import される。
// `chain.ts` は `node:crypto` を取り込むので、そこから引くと Node の API がクライアントの
// バンドルへ入ってビルドが壊れる。`src/lib/body-limits.ts` が `next.config.ts` のために
// 「定数だけ」を保っているのと同じ形にして、どこからでも安全に読めるようにする。

/**
 * テナントの最初の行の連番。
 *
 * **1 始まりであることをここが決める。** 採番・検証・途中からの読み出しの 3 か所が
 * 「先頭はどれか」を知る必要があるので、裸の `1n` を散らさず 1 つの定数から読む。
 */
export const FIRST_AUDIT_SEQ = 1n;

/**
 * 連番が取りうる最大値（PostgreSQL の `BIGINT` = 符号付き 64 ビットの上限）。
 *
 * **これを超える値は DB へ渡す前に弾く。** `AuditLog.seq` は `BigInt` なので、範囲外の値を
 * `where: { seq: { gte: … } }` に入れると PostgreSQL が拒否し、利用者の入力が原因なのに
 * **500 とスタックのログ**になる（検証 API はクエリ 1 つで何度でも叩ける）。
 *
 * **memory アダプタでは再現しない** — 全行が「その連番より小さい」として空を返すだけなので、
 * API テストは 422 に見える（ADR-0006 の構造的な死角）。だからこの上限は入口の検証で持つ。
 */
export const MAX_AUDIT_SEQ = 9_223_372_036_854_775_807n;

/**
 * 連番を 10 進で書いたときの最大桁数（`MAX_AUDIT_SEQ` の桁数）。
 *
 * **BigInt へ直す前に長さで落とすために使う。** 桁数を見ないと、何万桁もある数字列を
 * `BigInt()` に通してから捨てることになる（§9 のリソース枯渇対策。上限そのものの判定は
 * この後の比較が行うので、ここは「明らかに長すぎる入力」を手前で切るための門）。
 */
export const MAX_AUDIT_SEQ_DIGITS = MAX_AUDIT_SEQ.toString().length;
