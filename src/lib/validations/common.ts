// 各スキーマで共有する部品 (長さ上限は OpenAPI 定義と一致させる)
import { z } from 'zod';

// Zod の既定メッセージを日本語にする (issues.message も他の文言と同じく日本語で返す。全スキーマがこのモジュールを経由する)
z.config(z.locales.ja());
import { parseMicroUsd } from '@/domain/money';
import { API_MESSAGES } from '@/lib/constants';
import { normalizeEmail } from '@/domain/email';
import { AgentStatus, Provider, Role } from '@/domain/types';

// 表示名など短い文字列 (1〜100 文字)。前後の空白を除いてから長さを見る (空白だけの名前や末尾空白違いの「同名」を作らない)
export const shortText = z.string().trim().min(1).max(100);
// メールアドレス (RFC 5321 の上限 254 文字)。小文字に正規化する (テナント内の一意性 (tenantId, email) と
// findByEmail が大文字小文字の違いで別人扱いしないため。正規化の規則は normalizeEmail が唯一の定義)
export const email = z.email().max(254).transform(normalizeEmail);
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
      ctx.addIssue({ code: 'custom', message: API_MESSAGES.microUsdOutOfRange });
      return z.NEVER;
    }
    // BigInt を返す
    return parsed;
  });
// 説明文 (最大 1000 文字)。前後の空白は除く
export const longText = z.string().trim().max(1000);
