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

/**
 * payload が上の形かを**実行時に**確かめる。
 *
 * 型注釈だけでは守れない: DB の列は `Json?` なので、読み出した値は `unknown` 相当で、
 * 型アサーションは実行時に何も検査しない。入れ子の値が 1 つでも混ざると、正規化が
 * その階層のキーを並べ替えないため **JSONB の内部順序に依存してハッシュが揺れ**、
 * 誰も改ざんしていない行が hash_mismatch になる (しかも再現が不定)。
 * 書き込み前は throw で止め (fail-closed)、読み出し時は「検証できない行」として扱う。
 */
export function isAuditPayload(value: unknown): value is AuditPayload {
  // null・配列・オブジェクト以外は payload として受け付けない
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  // 値をすべて見て、平坦な原始値だけであることを確かめる
  return Object.values(value).every(
    (item) =>
      item === null ||
      typeof item === 'string' ||
      typeof item === 'number' ||
      typeof item === 'boolean',
  );
}

// ハッシュの計算に入れる 1 行ぶんの値。**列を足したらここにも足す** —
// ここに無い列は連鎖で守られないので、書き換えても検証を素通りする。
//
// **`createdAt` はアプリ側が決めてそのまま保存する。** この表だけは、他の表で使っている
// 「発生日時は DB の既定値 (`CURRENT_TIMESTAMP`) に任せる」という慣習に**従わない** —
// 従うと、ハッシュに入れた時刻 (アプリの `new Date()`) と保存された時刻 (トランザクション開始時刻) が
// 別の瞬間になり、**全行が初日から hash_mismatch になる**。Port の入力で必須にして取り違えを防ぐ。
export interface AuditChainRow {
  id: string; // 主キー (行の同一性。ハッシュに入れないと 2 行の id を入れ替えても検証を素通りする)
  tenantId: string; // 所属テナント (テナントごとに独立した連鎖)
  seq: bigint; // テナントごとの連番 (1 始まり)
  actorId: string | null; // 操作したユーザー (システム操作なら null)
  action: string; // 操作名 (例: agent.suspend)
  targetType: string; // 対象の種類 (例: Agent)
  targetId: string; // 対象の ID
  payload: AuditPayload | null; // 操作の詳細 (機微情報は入れない)
  createdAt: Date; // 記録日時 (アプリが決めた値。上のコメントを参照)
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
  // payload を正規化できない形 (入れ子・配列) で保存されている (= ハッシュを再計算できない)
  payload_not_canonical: 'payload_not_canonical',
  // 検証しようとしたテナント以外の行が混ざっている (= 取り出すクエリのテナント条件が壊れている)
  tenant_mismatch: 'tenant_mismatch',
} as const;
// AuditChainBreak の値の型
export type AuditChainBreak = (typeof AuditChainBreak)[keyof typeof AuditChainBreak];

// 連鎖の検証結果。壊れていたときは**最初に壊れた位置と理由**を返す
// (そこから後ろは連鎖の性質上すべて不整合になるので、先頭の 1 件だけが原因を指す)。
// `verified` は**実際に検証し終えた行数**で、壊れた行とその後ろは含まない
// (渡された件数を返すと「1 万行すべて確かめたが 1 行だけ壊れていた」と誤読される)
export type AuditChainVerification =
  | { ok: true; verified: number }
  | { ok: false; verified: number; brokenSeq: bigint; reason: AuditChainBreak };

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
    row.id,
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

/**
 * テナントの最初の行の連番。
 *
 * **1 始まりであることをここが決める。** 採番・検証・途中からの読み出しの 3 か所が
 * 「先頭はどれか」を知る必要があるので、裸の `1n` を散らさず 1 つの定数から読む
 */
export const FIRST_AUDIT_SEQ = 1n;

// 次の行の連番 (直前の行が無ければ先頭から始める)
export function nextAuditSeq(previousSeq: bigint | null): bigint {
  // 直前が無ければ先頭、あれば +1
  return previousSeq === null ? FIRST_AUDIT_SEQ : previousSeq + 1n;
}

/**
 * 途中から検証するときの錨 (`verifyAuditChain` の省略可能な引数)。
 *
 * **行数が 1 回の上限を超えるテナントではこれが無いと検証が止まる** — 錨が無ければ常に
 * 先頭の `limit` 件しか確かめられず、それ以降の行は二度と検証されない (新しい行を書き換えても
 * 「無傷」と答える状態になる)。`expectedSeq` の 1 つ前の行のハッシュを `previousHash` に渡す。
 */
export interface AuditChainAnchor {
  // 最初に見る行の連番 (この行の seq がこれと一致することを要求する)
  expectedSeq: bigint;
  // その 1 つ前の行のハッシュ (前の行が無ければ null)
  previousHash: string | null;
}

// 連鎖を検証する 1 行ぶんの入力。**payload は `unknown` で受ける** —
// DB の `Json?` 列をそのまま渡せるようにし、形の検査は検証の中で行う (型アサーションに頼らない)
export interface StoredAuditRow extends Omit<AuditChainRow, 'payload'> {
  payload: unknown; // 保存されている詳細 (形は isAuditPayload で確かめる)
  hash: string; // 保存されているハッシュ (再計算した値と比べる相手)
}

// 2 つのハッシュ (null を含む) が等しいかを、注入された定数時間比較で確かめる。
// **null の扱いをここに集約する** — 呼び出し側で `!==` を書くと、同じ関数の中に
// 「定数時間で比べる経路」と「素の比較で比べる経路」が混在する
function sameHash(
  left: string | null,
  right: string | null,
  hashesEqual: (a: string, b: string) => boolean,
): boolean {
  // どちらも無ければ等しい (テナントの最初の行の prevHash)
  if (left === null && right === null) return true;
  // 片方だけ無ければ等しくない
  if (left === null || right === null) return false;
  // どちらもあるので定数時間比較に掛ける
  return hashesEqual(left, right);
}

// 連鎖を検証する。**rows は seq の昇順で渡す** (呼び出し側が並べる。並び替えをここでやらないのは、
// 「保存されている順序」そのものを検査の対象にしたいため)。
// 第 2 引数に**検証したいテナント**を渡す — 行に載っている `tenantId` を信じるだけだと、
// 取り出すクエリのテナント条件が壊れたときに「別テナントの連鎖を検証して ok を返す」
// (= 検証したはずのテナントは 1 行も見ていない) という偽の合格が成立する (ADR-0002)。
// 第 4 引数は 1 行ぶんのハッシュ比較で、定数時間比較の実装 (src/lib/tokens.ts の secretsEqual) を
// 注入する。ドメイン層が node:crypto の比較まで抱えないようにしつつ、比較の方式は 1 か所に保つ。
//
// **残る境界 (意図的)**: 末尾の行をまとめて消されたことは、この検証では分からない。
// 1〜N の連鎖から N だけを消すと 1〜N-1 は完全に整合しているので、「そこまでしか無かった」のと
// 区別が付かない。区別するには「最後の行はこれだ」と外部に記録した錨 (anchor) が要り、それは
// この連鎖とは別の仕組み (外部への定期的なハッシュ送出など) になる。途中の削除・行の差し込み・
// 値の書き換えはすべて検知できるので、DB の追記専用トリガ (UPDATE 拒否 / DELETE は宣言必須) と
// 組み合わせて「消すには権限と明示的な宣言が要り、消したら連鎖か錨で分かる」を成立させている。
export function verifyAuditChain(
  secret: string,
  tenantId: string,
  rows: readonly StoredAuditRow[],
  hashesEqual: (left: string, right: string) => boolean,
  anchor?: AuditChainAnchor,
): AuditChainVerification {
  // 直前の行のハッシュ (最初の行の prevHash はこれと同じであることを要求する)。
  // **途中から検証するときは錨のハッシュから始める** — 省略時は先頭なので null
  let previousHash: string | null = anchor?.previousHash ?? null;
  // 期待する連番 (先頭から 1 ずつ増える。途中からなら錨が示す連番から)
  let expectedSeq = anchor?.expectedSeq ?? FIRST_AUDIT_SEQ;
  // 検証し終えた行数 (壊れた行は含めない)
  let verified = 0;
  // 先頭から 1 行ずつ見る
  for (const row of rows) {
    // 壊れていたときに返す形を組み立てる関数 (理由だけが違うので 1 か所にまとめる)
    const broken = (reason: AuditChainBreak): AuditChainVerification => ({
      ok: false,
      verified,
      brokenSeq: row.seq,
      reason,
    });
    // 検証したいテナント以外の行が混ざっていたら、そこで止める (取り出し側の条件が壊れている)
    if (row.tenantId !== tenantId) return broken(AuditChainBreak.tenant_mismatch);
    // 連番が期待どおりでなければ、行が削除されている (または採番が壊れている)
    if (row.seq !== expectedSeq) return broken(AuditChainBreak.seq_not_sequential);
    // prevHash が直前の行のハッシュと一致しなければ、行が差し込まれている
    if (!sameHash(row.prevHash, previousHash, hashesEqual)) {
      return broken(AuditChainBreak.prev_hash_mismatch);
    }
    // payload が正規化できない形なら、ハッシュを再計算できない (= 検証できない)
    if (row.payload !== null && !isAuditPayload(row.payload)) {
      return broken(AuditChainBreak.payload_not_canonical);
    }
    // 形を確かめた payload で、この行の値からハッシュを再計算する
    const recomputed = auditRowHash(secret, {
      ...row,
      payload: row.payload as AuditPayload | null,
    });
    // 保存されているハッシュと一致しなければ、値が書き換えられている
    if (!hashesEqual(recomputed, row.hash)) return broken(AuditChainBreak.hash_mismatch);
    // この行は検証できたので、次の行のために状態を進める
    previousHash = row.hash;
    expectedSeq = row.seq + 1n;
    verified += 1;
  }
  // 1 行も壊れていなかった
  return { ok: true, verified };
}
