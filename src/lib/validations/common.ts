// 各スキーマで共有する部品 (長さ上限は OpenAPI 定義と一致させる)
import { z } from 'zod';
import { parseMicroUsd } from '@/domain/money';
import { AgentStatus, Provider, Role } from '@/domain/types';

// 表示名など短い文字列 (1〜100 文字)
export const shortText = z.string().min(1).max(100);
// メールアドレス (RFC 5321 の上限 254 文字)
export const email = z.email().max(254);
// 役割 (正準の enum から導く)
export const role = z.enum(Object.values(Role));
// LLM プロバイダ
export const provider = z.enum(Object.values(Provider));
// エージェントの稼働状態
export const agentStatus = z.enum(Object.values(AgentStatus));
// マイクロ USD (文字列 → BigInt。形と範囲は domain/money が判定する)
export const microUsd = z
  .string()
  .max(19)
  .transform((value, ctx) => {
    // 純粋関数で変換する
    const parsed = parseMicroUsd(value);
    // 変換できなければ検証エラーにする
    if (parsed === null) {
      ctx.addIssue({
        code: 'custom',
        message: '0 以上 9223372036854775807 以下の整数を文字列で指定してください。',
      });
      return z.NEVER;
    }
    // BigInt を返す
    return parsed;
  });
// 説明文 (最大 1000 文字)
export const longText = z.string().max(1000);
