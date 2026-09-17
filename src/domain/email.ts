// メールアドレスの正規化 (純粋関数)。API の入力検証と CLI の検索が同じ規則を使う

// 前後の空白を除き、小文字にそろえる (ローカル部の大文字小文字を区別するメールサーバは実用上無く、
// 区別すると同じ受信箱に 2 つのアカウントが作れてしまう)
export function normalizeEmail(value: string): string {
  // 空白除去 → 小文字化
  return value.trim().toLowerCase();
}
