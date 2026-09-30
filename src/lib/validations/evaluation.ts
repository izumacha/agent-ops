// 評価セットの作成・評価実行の本文と、実行一覧のクエリの検証。
// 本文は z.strictObject（未知キーは 422）で、契約側の additionalProperties: false と対にする
import { z } from './zod';
import { longText, resourceId, shortText } from './common';
import { API_MESSAGES, EVALUATION_SET_MAX_CASES } from '@/lib/constants';

// 評価ケース 1 件（入力は必須、期待する出力は任意）
const evaluationCaseSchema = z.strictObject({
  // エージェントへ投げる入力
  input: longText,
  // 期待する出力（採点の参考情報。省略可）
  expected: longText.optional(),
});

// 評価セットの作成本文
export const evaluationSetCreateSchema = z.strictObject({
  // 表示名（テナント内で一意）
  name: shortText,
  // ケース（配列の順がそのまま position になる）。
  // **上限を置くのは §8/§9**（1 リクエストで無制限のケースを作らせない）。
  // 下限 1 は「ケースの無いセットは実行しても何も測れない」ため
  cases: z
    .array(evaluationCaseSchema)
    .min(1, { message: API_MESSAGES.evaluationSetEmpty })
    .max(EVALUATION_SET_MAX_CASES, { message: API_MESSAGES.evaluationSetTooLarge }),
});

// 評価実行の本文（どのエージェントを、どのセットで評価するか）
export const evaluationRunCreateSchema = z.strictObject({
  // 評価対象エージェント
  agentId: resourceId,
  // 使う評価セット
  setId: resourceId,
});

// 実行一覧のクエリ（回帰比較のため、エージェント・セットで絞れる）
export const evaluationRunQuerySchema = z.object({
  // エージェントで絞る
  agentId: resourceId.optional(),
  // 評価セットで絞る
  setId: resourceId.optional(),
});
