// データ層 (Ports & Adapters) が投げるエラー。API 層はこれを HTTP ステータスへ写す (DuplicateError → 422)。
// Prisma の例外型 (PrismaClientKnownRequestError) を API 層へ持ち出さないための翻訳先で、
// memory アダプタも同じ型を投げるので、API テストは本番と同じ経路で 422 を確かめられる。

// 一意制約違反 (同一テナント内の名前・メール重複など)
export class DuplicateError extends Error {
  // 重複したフィールド名 (422 応答の issues.path に載せる)
  readonly field: string;

  // フィールド名を受け取って例外を組み立てる
  constructor(field: string) {
    // 人が読めるメッセージを親クラスへ渡す
    super(`重複: ${field}`);
    // 例外の名前を型名に合わせる (ログで見分けるため)
    this.name = 'DuplicateError';
    // どのフィールドが重複したかを保持する
    this.field = field;
  }
}
