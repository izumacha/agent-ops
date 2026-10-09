// /api/v1/metrics: プロセス内のカウンタを Prometheus のテキスト形式で返す（監視専用トークン）。
//
// **なぜ専用の資格情報か（§9 最小権限）。** 以前はプラットフォーム管理者トークンで守っていたが、
// あれは `POST /tenants`（**応答に新しいテナントの admin トークンの平文が載る**）と
// `PATCH /tenants/{tenantId}`（プランと課金の紐付けの変更）も通る。監視の収集エージェントへ
// 配る値にそこまでの権限を持たせない（理由と代替案は `src/lib/api/metrics-auth.ts`）。
//
// **なぜテナントの利用者に見せないか。** 値はインスタンス全体の合計で、テナントごとに分かれていない
// （ラベルにテナント id を入れると系列がテナント数だけ増え、しかも他テナントの活動量が読める）。
// テナントの利用者が見るべき数字は `GET /usage/daily` と画面が持つ。
//
// **なぜ DB を引かないか。** 耐久する事実（利用量・インシデント・監査ログ）は DB にあり、
// それを返す経路は既にある。ここで数えるのは**DB に残らないもの**（応答の数と、ログに出した
// 出来事の数）だけなので、スクレイプのたびに DB を触らない＝監視が本番の負荷にならない。
//
// **レート制限はアプリ側で掛けられない。** 枠のキーは認証済みの主体（テナント・ユーザー・
// エージェントの id）から作るので、テナントを持たないこの経路にはキーが無い。未認証の相手を
// ヘッダ（偽装できる `X-Forwarded-For`）で数える形は、正規の収集エージェントの枠を third party に
// 枯渇させられるので採らない。**前段のリバースプロキシの責務**（受信 Webhook と同じ扱い。
// README の「前段の責務」と `docs/deploy.md` に書いてある）。照合そのものは
// `secretsEqual`（定数時間・両辺をハッシュしてから比較）なので、総当たりはトークンの
// 乱数長（`METRICS_TOKEN_MIN_LENGTH` 以上）に対して行うことになる。
//
// **`route()` を通らない**（Bearer から `Principal` を決める仕組みに乗らないため）。代わりに
// `tests/route-wrapping.test.ts` の理由付きの表へ登録し、**監視用トークンの入口へ到達すること**を
// 機械で要求している（応答を数えることと `no-store` は `withResponseCount` を通ることで満たす。
// 同テストが全 export にその印を要求し、実際のヘッダも応答を作って確かめる）。
import { withResponseCount } from '@/lib/api/response-count';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { assertMetricsToken } from '@/lib/api/metrics-auth';
import { PROMETHEUS_CONTENT_TYPE } from '@/lib/constants';
import { renderMetrics } from '@/lib/metrics';

// 数字は毎回その場の値なので、Next.js の静的化を無効にして常に動的に応答する
export const dynamic = 'force-dynamic';

// GET /metrics: 現在の値を書き出す (getMetrics)。
// **応答を数えるのと例外を応答へ写すのは `withResponseCount` が受け持つ**
// （`route()` を通る経路と同じ 1 本。自分自身の 200 / 401 / 503 も数に入る）
export const GET = withResponseCount(async (request: Request): Promise<Response> => {
  // 監視用トークンを照合する（未設定・短すぎは 503、合わなければ 401）
  assertMetricsToken(request);
  // いまの値をテキストへ書き出す（判定はしない。しきい値はスクレイプ側が決める）
  const body = renderMetrics();
  // JSON ではないので Response.json は使わず、形式を名乗って返す。
  // **`no-store` は包む側（`withResponseCount`）が付ける** — 認証付きの運用情報なので
  // 共有キャッシュへは載せないが、付ける場所は `route()` を通る経路と同じ 1 か所にそろえる
  // （自分でも付けていた頃は `Vary` が二重に並んでいた）
  return new Response(body, {
    status: HTTP_STATUS.OK,
    headers: { 'Content-Type': PROMETHEUS_CONTENT_TYPE },
  });
});
