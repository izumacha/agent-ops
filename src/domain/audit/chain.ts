// 監査ログの改ざん検知 (ハッシュ連鎖) の**唯一の真実の源**。
// 書き込み側 (src/lib/audit/record.ts) と検証側 (verifyAuditChain) が同じ正規化・同じ計算を通るので、
// 「書くときと読むときで文字列の作り方が違う」ことが起こりえない (§6 DRY)。
// DB・Next.js に依存しない純粋ロジックなので、ユニットテストで境界を全部固定できる (§11)。
import { createHmac } from 'node:crypto';

// 監査ログの詳細 (payload 列) に入れられる値の形。**入れ子を許さない平坦な辞書に限る。**
// 理由は 2 つ。(1) 正規化がキーの並べ替えだけで済み、再帰の実装を持たなくてよい。
// (2) JSONB は**キーの順序を保存しない**ので、保存して読み直すと書いたときと順序が変わりうる。
// 平坦なら「キーを辞書順に並べる」だけで順序の違いを消せる (入れ子だと各階層で同じ処理が要る)。
export type AuditPayload = Readonly<Record<string, string | number | boolean | null>>;

// ハッシュの計算に入れる 1 行ぶんの値。**列を足したらここにも足す** —
// ここに無い列は連鎖で守られないので、書き換えても検証を素通りする
export interface AuditChainRow {
  tenantId: string; // 所属テナント (テナントごとに独立した連鎖なので、鍵の一部として入れる)
  seq: bigint; // テナントごとの連番 (1 始まり)
  actorId: string | null; // 操作したユーザー (システム操作なら null)
  action: string; // 操作名 (例: agent.suspend)
  targetType: string; // 対象の種類 (例: Agent)
  targetId: string; // 対象の ID
  payload: AuditPayload | null; // 操作の詳細 (機微情報は入れない)
  createdAt: Date; // 記録日時
  prevHash: string | null; // 直前の行のハッシュ (テナントの最初の行だけ null)
}

// 連鎖が壊れていた理由。**どの壊れ方かを区別する**のは、運用で原因を切り分けるため
// (ハッシュ不一致は値の書き換え、連番の飛びは行の削除、prevHash の不一致は行の差し込み)
export const AuditChainBreak = {
  // 記録されているハッシュが、その行の値から再計算した値と一致しない (= 値が書き換えられた)
  hash_mismatch: 'hash_mismatch',
  // prevHash が直前の行のハッシュと一致しない (= 行が差し込まれた・並べ替えられた)
  prev_hash_mismatch: 'prev_hash_mismatch',
  // 連番が 1 から 1 ずつ増えていない (= 行が削除された)
  seq_not_sequential: 'seq_not_sequential',
} as const;
// AuditChainBreak の値の型
export type AuditChainBreak = (typeof AuditChainBreak)[keyof typeof AuditChainBreak];

// 連鎖の検証結果。壊れていたときは**最初に壊れた位置と理由**を返す
// (そこから後ろは連鎖の性質上すべて不整合になるので、先頭の 1 件だけが原因を指す)
export type AuditChainVerification =
  | { ok: true; checked: number }
  | { ok: false; checked: number; brokenSeq: bigint; reason: AuditChainBreak };

// ハッシュに入れる 1 行を、曖昧さの無い 1 本の文字列にする (正規化)。
// **JSON の配列にする**のが要点で、区切り文字で連結すると値の中にその文字が入ったときに
// 隣の項目と境界がずれ、「別の内容なのに同じ文字列」になる組み合わせを作れてしまう
// (例: action='a|b' + targetType='c' と action='a' + targetType='b|c')。
// 配列なら位置が固定され、エスケープは JSON.stringify が受け持つ
function canonicalAuditRow(row: AuditChainRow): string {
  // payload を一度ローカルに取り出す (後段の map の中で null でないことを型の上でも保つため)
  const payload = row.payload;
  // payload はキーを辞書順に並べた [キー, 値] の配列にする (JSONB がキー順を保存しないため)
  const payloadPairs =
    payload === null
      ? null
      : Object.keys(payload)
          .sort()
          .map((key) => [key, payload[key]]);
  // 列の並びを固定した配列として文字列化する (順序を変えたら過去の行の検証が全部壊れる)
  return JSON.stringify([
    row.tenantId,
    // BigInt は JSON.stringify が扱えないので 10 進文字列にする
    row.seq.toString(),
    row.actorId,
    row.action,
    row.targetType,
    row.targetId,
    payloadPairs,
    // Date も ISO 8601 の文字列にする (DB の TIMESTAMP(3) とミリ秒まで一致する)
    row.createdAt.toISOString(),
    row.prevHash,
  ]);
}

// 1 行のハッシュを計算する (HMAC-SHA256 の 16 進文字列)。
// **鍵つきにする**のが要点。鍵なしの素のハッシュだと、DB への書き込み権限を得た相手が
// 値を書き換えたうえでハッシュも連鎖もまるごと作り直せるので、検知の役に立たない
export function auditRowHash(secret: string, row: AuditChainRow): string {
  // 鍵と正規化した文字列から HMAC を求め、16 進文字列で返す
  return createHmac('sha256', secret).update(canonicalAuditRow(row), 'utf8').digest('hex');
}

// 次の行の連番 (直前の行が無ければ 1 から始める)
export function nextAuditSeq(previousSeq: bigint | null): bigint {
  // 直前が無ければ 1、あれば +1
  return previousSeq === null ? 1n : previousSeq + 1n;
}

// 連鎖を検証する 1 行ぶんの入力 (記録されているハッシュも照合に要る)
export interface StoredAuditRow extends AuditChainRow {
  hash: string; // 保存されているハッシュ (再計算した値と比べる相手)
}

// 連鎖を検証する。**rows は seq の昇順で渡す** (呼び出し側が並べる。並び替えをここでやらないのは、
// 「保存されている順序」そのものを検査の対象にしたいため)。
//
// **残る境界 (意図的)**: 末尾の行をまとめて消されたことは、この検証では分からない。
// 1〜N の連鎖から N だけを消すと 1〜N-1 は完全に整合しているので、「そこまでしか無かった」のと
// 区別が付かない。区別するには「最後の行はこれだ」と外部に記録した錨 (anchor) が要り、それは
// この連鎖とは別の仕組み (外部への定期的なハッシュ送出など) になる。途中の削除・行の差し込み・
// 値の書き換えはすべて検知できるので、DB の追記専用トリガ (UPDATE 拒否 / DELETE は宣言必須) と
// 組み合わせて「消すには権限と明示的な宣言が要り、消したら連鎖か錨で分かる」を成立させている。
// 第 3 引数は 1 行ぶんのハッシュ比較で、定数時間比較の実装 (src/lib/tokens.ts の secretsEqual) を
// 注入する。ドメイン層が node:crypto の比較まで抱えないようにしつつ、比較の方式は 1 か所に保つ
export function verifyAuditChain(
  secret: string,
  rows: readonly StoredAuditRow[],
  hashesEqual: (left: string, right: string) => boolean,
): AuditChainVerification {
  // 直前の行のハッシュ (最初の行の prevHash はこれと同じ null であることを要求する)
  let previousHash: string | null = null;
  // 期待する連番 (1 から 1 ずつ増える)
  let expectedSeq = 1n;
  // 先頭から 1 行ずつ見る
  for (const row of rows) {
    // 連番が期待どおりでなければ、行が削除されている (または採番が壊れている)
    if (row.seq !== expectedSeq) {
      return {
        ok: false,
        checked: rows.length,
        brokenSeq: row.seq,
        reason: AuditChainBreak.seq_not_sequential,
      };
    }
    // prevHash が直前の行のハッシュと一致しなければ、行が差し込まれている
    if (row.prevHash !== previousHash) {
      return {
        ok: false,
        checked: rows.length,
        brokenSeq: row.seq,
        reason: AuditChainBreak.prev_hash_mismatch,
      };
    }
    // この行の値からハッシュを再計算する
    const recomputed = auditRowHash(secret, row);
    // 保存されているハッシュと一致しなければ、値が書き換えられている
    if (!hashesEqual(recomputed, row.hash)) {
      return {
        ok: false,
        checked: rows.length,
        brokenSeq: row.seq,
        reason: AuditChainBreak.hash_mismatch,
      };
    }
    // 次の行のために、直前のハッシュと期待する連番を進める
    previousHash = row.hash;
    expectedSeq = row.seq + 1n;
  }
  // 1 行も壊れていなかった
  return { ok: true, checked: rows.length };
}
