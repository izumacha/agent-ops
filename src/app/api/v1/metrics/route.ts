// /api/v1/metrics: プロセス内のカウンタを Prometheus のテキスト形式で返す（プラットフォーム管理者のみ）
//
// **なぜプラットフォーム管理者だけか。** 値はインスタンス全体の合計で、テナントごとに分かれていない
// （ラベルにテナント id を入れると系列がテナント数だけ増え、しかも他テナントの活動量が読める）。
// テナントの利用者が見るべき数字は `GET /usage/daily` と画面が持つ。
//
// **なぜ DB を引かないか。** 耐久する事実（利用量・インシデント・監査ログ）は DB にあり、
// それを返す経路は既にある。ここで数えるのは**DB に残らないもの**（応答の数と、ログに出した
// 出来事の数）だけなので、スクレイプのたびに DB を触らない＝監視が本番の負荷にならない。
import { requirePlatformAdmin } from '@/lib/api/guard';
import { route } from '@/lib/api/handler';
import { HTTP_STATUS } from '@/lib/api/http-status';
import { PROMETHEUS_CONTENT_TYPE } from '@/lib/constants';
import { renderMetrics } from '@/lib/metrics';

// GET /metrics: 現在の値を書き出す (getMetrics)
export const GET = route(async ({ principal }) => {
  // プラットフォーム管理者だけ（テナント境界の外側の数字なので）
  requirePlatformAdmin(principal);
  // いまの値をテキストへ書き出す（判定はしない。しきい値はスクレイプ側が決める）
  const body = renderMetrics(new Date());
  // JSON ではないので Response.json は使わず、形式を名乗って返す
  return new Response(body, {
    status: HTTP_STATUS.OK,
    headers: { 'Content-Type': PROMETHEUS_CONTENT_TYPE },
  });
});
