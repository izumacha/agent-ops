// 資源 id (cuid) の「形」の規則の唯一の定義。
//
// **どこから来た id かを問わず同じ規則で見る。** URL のパスセグメント・本文に載る id・カーソルへ
// 符号化した id はどれも外部入力で、形を見ずに DB へ渡すと PostgreSQL が NUL (0x00) を含む text を
// 拒否して 500 になる (実測: 本番ビルドへ `GET /api/v1/agents/%00` を投げると、Next.js が
// percent-decode した NUL がそのままアダプタへ届き 500 とスタックのログが積まれた。認証さえ通れば
// 最小権限の viewer でも無制限に繰り返せるので、本物の障害がログに埋もれる)。
// memory アダプタは「表に無い」だけなので同じ入力が 404 に見え、API テストからは死角になる
// (Ports & Adapters が構造的に抱える死角。ADR-0006)。だから判定は id を受け取る入口に置く。

// 資源 id の最大長 (cuid は 25 文字。テスト用の読みやすい id も収まるよう余裕を持たせる)
export const RESOURCE_ID_MAX_LENGTH = 64;

// 許す文字は英数字と `-` `_` だけ (cuid とテスト用 id がこの範囲に収まる)。
// 量指定子を入れ子にしないので入力長に対して線形時間で判定できる (§9 ReDoS を作らない)
const RESOURCE_ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{1,${RESOURCE_ID_MAX_LENGTH}}$`);

/** 資源 id として受け取ってよい形か (文字列でない値・空文字・長すぎる値・制御文字混じりはすべて false) */
export function isResourceId(value: unknown): value is string {
  // 文字列でなければ id ではない (配列で届く catch-all セグメントなどもここで落ちる = fail-closed)
  if (typeof value !== 'string') return false;
  // 文字種と長さを見る
  return RESOURCE_ID_PATTERN.test(value);
}
